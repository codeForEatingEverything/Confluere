//! In-process revm harness around the compiled Confluere contracts (`artifacts/`, see `SOURCE.txt`).
//! Deploys the three linked logic libraries, the core and mock tokens, then drives them with Alloy-encoded
//! calls. Used to cross-check the Rust model against the real bytecode for the rules the contracts implement.

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall, SolValue};
use anyhow::{anyhow, bail, Context as _, Result};
use revm::context::result::{ExecutionResult, Output};
use revm::context::TxEnv;
use revm::database::{CacheDB, EmptyDB};
use revm::primitives::{hardfork::SpecId, TxKind};
use revm::state::AccountInfo;
use revm::{Context, ExecuteCommitEvm, MainBuilder, MainContext, MainnetEvm};

sol! {
    struct GridConfig { uint64 anchor; uint64 period; uint64 batchInterval; uint32 maxExpiries; uint8 strikeSigDigits; }
    struct ChainParams {
        uint256 chainId; uint64 windowBlocks; uint64 maxPauseBlocks; address treasury; address guardian;
        address[] graduationQuotes; uint256[] graduationVolumes; address[] minNotionalQuotes; uint256[] minNotionals;
    }
    struct Config { GridConfig grid; uint32 maxOrdersPerSide; uint32 maxBids; ChainParams[] chains; }
    struct PoolKey { address asset; address quote; uint64 expiry; uint128 strike; uint8 kind; }
    struct OrderParams { uint8 side; uint96 units; uint96 limit; uint128 budget; uint16 ttl; uint64 hint; address owner; }
    struct Erc20Ctor { string name; string symbol; uint8 decimals; }
    struct PoolOptions { uint8 cadence; uint96 minFill; uint96 firstLo; uint96 firstHi; }
    struct PoolView {
        PoolKey key; uint8 status; uint8 assetDecimals; uint16 feeBps; uint16 bandBps; uint8 bandFailures;
        uint32 settleCount; uint64 lastSettledBatch; uint64 windowEnd; uint64 pausedUntil; uint96 lastClearingPrice;
        uint96 bandBase; uint256 quoteBal; uint256 assetBal; uint256 surplusBal; uint256 vwap; uint256 closeRemaining;
        PoolOptions options; uint64 batchInterval;
    }
    interface ICore {
        function createPool(PoolKey key, uint16 feeBps, uint16 bandBps) external returns (bytes32);
        function placeOrder(bytes32 poolId, OrderParams p) external returns (uint64);
        function settleBatch(bytes32 poolId) external;
        function repay(bytes32 poolId, uint96 units) external;
        function mature(bytes32 poolId) external;
        function closeWindow(bytes32 poolId, uint256 maxBids) external returns (bool);
        function claim(bytes32 poolId) external returns (uint256, uint256);
        function withdraw(address token, address to) external returns (uint256);
        function findHint(bytes32 poolId, uint8 side, uint96 limit) external view returns (uint64);
        function bid(bytes32 poolId, uint96 units, uint96 surplusPerUnit, uint64 hint) external returns (uint64);
        function rollover(bytes32 oldPoolId, bytes32 newPoolId, uint96 units, uint96 minPrice, uint128 maxTopUp, uint16 ttl, uint64 hint) external returns (uint64);
        function flashLoan(address receiver, address token, uint256 amount, bytes data) external returns (bool);
        function flashFees(address token) external view returns (uint256);
        function cancelOrder(bytes32 poolId, uint64 orderId) external;
        function pause(bytes32 poolId, uint64 blocks) external;
        function bookHead(bytes32 poolId, uint8 side) external view returns (uint64, uint32);
        function order(bytes32 poolId, uint64 orderId) external view returns (address owner, uint8 side, uint96 units, uint96 limit, uint128 escrow, uint32 deadline, uint64 next);
        function pool(bytes32 poolId) external view returns (PoolView);
        function pending(address token, address account) external view returns (uint256);
        function balanceOf(address owner, uint256 id) external view returns (uint256);
        function vwap(bytes32 poolId) external view returns (uint256);
    }
    interface ReentrantBorrower {
        function setInner(bytes data) external;
        function innerSucceeded() external view returns (bool);
    }
    interface ReentrantToken {
        function mint(address to, uint256 amt) external;
        function approve(address s, uint256 a) external returns (bool);
        function setCore(address c, bytes data) external;
        function arm(bool a) external;
        function innerSucceeded() external view returns (bool);
    }
    interface IFlashBorrower {
        function setRepay(bool r) external;
        function seen() external view returns (uint256);
    }
    interface IERC20 {
        function mint(address to, uint256 amount) external;
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address a) external view returns (uint256);
    }
}

pub const SELL: u8 = 0;
pub const BUY: u8 = 1;
pub const NC_SELL: u8 = 2;
pub const NC_BUY: u8 = 3;
pub use alloy_sol_types::SolCall as _SolCall;
/// ABI-encode a core call for use inside hostile callbacks.
pub fn encode_settle(pool: B256) -> Vec<u8> {
    ICore::settleBatchCall { poolId: pool }.abi_encode()
}
pub fn encode_repay(pool: B256, units: u128) -> Vec<u8> {
    ICore::repayCall {
        poolId: pool,
        units: U256::from(units).to(),
    }
    .abi_encode()
}
pub fn encode_withdraw(token: Address, to: Address) -> Vec<u8> {
    ICore::withdrawCall { token, to }.abi_encode()
}
pub fn encode_place_sell(pool: B256, owner: Address, units: u128, limit: u128) -> Vec<u8> {
    ICore::placeOrderCall {
        poolId: pool,
        p: OrderParams {
            side: SELL,
            units: U256::from(units).to(),
            limit: U256::from(limit).to(),
            budget: U256::from(0u8).to(),
            ttl: 1,
            hint: 0,
            owner,
        },
    }
    .abi_encode()
}
pub fn encode_flash(receiver: Address, token: Address, amount: u128) -> Vec<u8> {
    ICore::flashLoanCall {
        receiver,
        token,
        amount: U256::from(amount),
        data: Bytes::new(),
    }
    .abi_encode()
}
pub fn encode_claim(pool: B256) -> Vec<u8> {
    ICore::claimCall { poolId: pool }.abi_encode()
}

pub struct Harness {
    evm: MainnetEvm<
        revm::context::Context<
            revm::context::BlockEnv,
            TxEnv,
            revm::context::CfgEnv,
            CacheDB<EmptyDB>,
            revm::Journal<CacheDB<EmptyDB>>,
            (),
        >,
    >,
    nonces: std::collections::HashMap<Address, u64>,
    pub core: Address,
    pub asset: Address,
    pub quote: Address,
    pub treasury: Address,
    pub grid: GridConfig,
    pub gas_used: Vec<(String, u64)>,
}

fn artifact(name: &str) -> Result<serde_json::Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../artifacts/");
    let s = std::fs::read_to_string(format!("{path}{name}.json"))
        .with_context(|| format!("artifact {name}"))?;
    Ok(serde_json::from_str(&s)?)
}

fn bytecode_hex(a: &serde_json::Value) -> String {
    a["bytecode"]["object"]
        .as_str()
        .unwrap()
        .trim_start_matches("0x")
        .to_string()
}

/// Substitute `__$...$__` placeholders using the artifact's linkReferences.
fn link(a: &serde_json::Value, libs: &[(&str, Address)]) -> Result<Vec<u8>> {
    let mut hex = bytecode_hex(a);
    if let Some(refs) = a["bytecode"]["linkReferences"].as_object() {
        for (_file, m) in refs {
            for (lib, spots) in m.as_object().unwrap() {
                let addr = libs
                    .iter()
                    .find(|(n, _)| n == lib)
                    .ok_or_else(|| anyhow!("unlinked {lib}"))?
                    .1;
                let hexaddr = alloy_primitives::hex::encode(addr.as_slice());
                for sp in spots.as_array().unwrap() {
                    let start = sp["start"].as_u64().unwrap() as usize * 2;
                    hex.replace_range(start..start + 40, &hexaddr);
                }
            }
        }
    }
    Ok(alloy_primitives::hex::decode(hex)?)
}

pub fn addr(n: u64) -> Address {
    Address::from_word(B256::from(U256::from(n)))
}

impl Harness {
    /// Deploys everything. `grid` anchor must be ≤ `start_ts`.
    pub fn new(
        grid: GridConfig,
        start_ts: u64,
        start_block: u64,
        window_blocks: u64,
        asset_decimals: u8,
        quote_decimals: u8,
    ) -> Result<Self> {
        let deployer = addr(0xdead);
        let treasury = addr(0xfee);
        let ctx = Context::mainnet()
            .with_db(CacheDB::new(EmptyDB::default()))
            .modify_cfg_chained(|c| {
                c.spec = SpecId::CANCUN;
                c.chain_id = 31337;
                c.limit_contract_code_size = Some(usize::MAX);
                c.limit_contract_initcode_size = Some(usize::MAX);
                c.disable_nonce_check = true;
            })
            .modify_block_chained(|b| {
                b.timestamp = U256::from(start_ts);
                b.number = U256::from(start_block);
                b.gas_limit = 1_000_000_000;
                b.basefee = 0;
            });
        let evm = ctx.build_mainnet();
        let mut h = Harness {
            evm,
            nonces: Default::default(),
            core: Address::ZERO,
            asset: Address::ZERO,
            quote: Address::ZERO,
            treasury,
            grid: grid.clone(),
            gas_used: Vec::new(),
        };
        h.fund(deployer);

        let order = h.deploy(deployer, link(&artifact("OrderLogic")?, &[])?, "OrderLogic")?;
        let clearing = h.deploy(
            deployer,
            link(&artifact("ClearingLogic")?, &[])?,
            "ClearingLogic",
        )?;
        let window = h.deploy(
            deployer,
            link(&artifact("WindowLogic")?, &[])?,
            "WindowLogic",
        )?;
        let libs = [
            ("OrderLogic", order),
            ("ClearingLogic", clearing),
            ("WindowLogic", window),
        ];
        let mut code = link(&artifact("Confluere")?, &libs)?;
        let cfg = Config {
            grid: grid.clone(),
            maxOrdersPerSide: 128,
            maxBids: 64,
            chains: vec![ChainParams {
                chainId: U256::from(31337),
                windowBlocks: window_blocks,
                maxPauseBlocks: window_blocks * 84,
                treasury,
                guardian: Address::ZERO,
                graduationQuotes: vec![],
                graduationVolumes: vec![],
                minNotionalQuotes: vec![],
                minNotionals: vec![],
            }],
        };
        code.extend((cfg,).abi_encode_params());
        h.core = h.deploy(deployer, code, "Confluere")?;

        let erc = artifact("MockERC20")?;
        let mut a = link(&erc, &[])?;
        a.extend(
            Erc20Ctor {
                name: "Asset".into(),
                symbol: "AST".into(),
                decimals: asset_decimals,
            }
            .abi_encode_params(),
        );
        h.asset = h.deploy(deployer, a, "MockERC20")?;
        let mut q = link(&erc, &[])?;
        q.extend(
            Erc20Ctor {
                name: "Quote".into(),
                symbol: "QT".into(),
                decimals: quote_decimals,
            }
            .abi_encode_params(),
        );
        h.quote = h.deploy(deployer, q, "MockERC20")?;
        Ok(h)
    }

    pub fn fund(&mut self, who: Address) {
        let db = &mut self.evm.ctx.journaled_state.database;
        db.insert_account_info(who, AccountInfo::from_balance(U256::from(10u128.pow(30))));
    }

    pub fn timestamp(&self) -> u64 {
        self.evm.ctx.block.timestamp.to::<u64>()
    }
    pub fn block_number(&self) -> u64 {
        self.evm.ctx.block.number.to::<u64>()
    }
    /// Advance time and blocks.
    pub fn warp(&mut self, ts: u64, block: u64) {
        self.evm.ctx.block.timestamp = U256::from(ts);
        self.evm.ctx.block.number = U256::from(block);
    }

    fn tx(
        &mut self,
        from: Address,
        kind: TxKind,
        data: Vec<u8>,
    ) -> Result<(Bytes, u64, Option<Address>)> {
        let nonce = *self.nonces.get(&from).unwrap_or(&0);
        let tx = TxEnv {
            caller: from,
            gas_limit: 300_000_000,
            gas_price: 0,
            kind,
            value: U256::ZERO,
            data: data.into(),
            nonce,
            chain_id: Some(31337),
            ..Default::default()
        };
        let res = self
            .evm
            .transact_commit(tx)
            .map_err(|e| anyhow!("evm: {e:?}"))?;
        self.nonces.insert(from, nonce + 1);
        match res {
            ExecutionResult::Success { output, gas, .. } => {
                let used = gas.tx_gas_used();
                match output {
                    Output::Call(b) => Ok((b, used, None)),
                    Output::Create(b, a) => Ok((b, used, a)),
                }
            }
            ExecutionResult::Revert { output, .. } => bail!("revert: {}", decode_revert(&output)),
            ExecutionResult::Halt { reason, .. } => bail!("halt: {reason:?}"),
        }
    }

    fn deploy(&mut self, from: Address, code: Vec<u8>, label: &str) -> Result<Address> {
        let (_, gas, a) = self
            .tx(from, TxKind::Create, code)
            .with_context(|| format!("deploy {label}"))?;
        self.gas_used.push((format!("deploy {label}"), gas));
        a.ok_or_else(|| anyhow!("no address for {label}"))
    }

    pub fn call<C: SolCall>(
        &mut self,
        from: Address,
        to: Address,
        c: C,
        label: &str,
    ) -> Result<C::Return> {
        let (out, gas, _) = self
            .tx(from, TxKind::Call(to), c.abi_encode())
            .with_context(|| label.to_string())?;
        self.gas_used.push((label.to_string(), gas));
        Ok(C::abi_decode_returns(&out)?)
    }

    pub fn mint(&mut self, token: Address, to: Address, amount: U256) -> Result<()> {
        self.fund(to);
        self.call(addr(0xdead), token, IERC20::mintCall { to, amount }, "mint")?;
        self.call(
            to,
            token,
            IERC20::approveCall {
                spender: self.core,
                amount: U256::MAX,
            },
            "approve",
        )?;
        Ok(())
    }

    pub fn balance_of(&mut self, token: Address, who: Address) -> Result<U256> {
        self.call(
            addr(0xbeef),
            token,
            IERC20::balanceOfCall { a: who },
            "balanceOf",
        )
    }

    pub fn create_pool(
        &mut self,
        creator: Address,
        expiry: u64,
        strike: u128,
        american: bool,
        fee_bps: u16,
        band_bps: u16,
    ) -> Result<B256> {
        let key = PoolKey {
            asset: self.asset,
            quote: self.quote,
            expiry,
            strike,
            kind: if american { 0 } else { 1 },
        };
        self.call(
            creator,
            self.core,
            ICore::createPoolCall {
                key,
                feeBps: fee_bps,
                bandBps: band_bps,
            },
            "createPool",
        )
    }

    pub fn place(
        &mut self,
        from: Address,
        pool: B256,
        side: u8,
        units: u128,
        limit: u128,
        budget: u128,
        ttl: u16,
    ) -> Result<u64> {
        let hint = if side <= BUY {
            self.call(
                from,
                self.core,
                ICore::findHintCall {
                    poolId: pool,
                    side,
                    limit: U256::from(limit).to(),
                },
                "findHint",
            )?
        } else {
            0
        };
        let p = OrderParams {
            side,
            units: U256::from(units).to(),
            limit: U256::from(limit).to(),
            budget: U256::from(budget).to(),
            ttl,
            hint,
            owner: from,
        };
        self.call(
            from,
            self.core,
            ICore::placeOrderCall { poolId: pool, p },
            "placeOrder",
        )
    }

    pub fn settle(&mut self, pool: B256) -> Result<u64> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::settleBatchCall { poolId: pool },
            "settleBatch",
        )?;
        Ok(self.gas_used.last().unwrap().1)
    }
    pub fn mature(&mut self, pool: B256) -> Result<()> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::matureCall { poolId: pool },
            "mature",
        )
        .map(|_| ())
    }
    pub fn repay(&mut self, from: Address, pool: B256, units: u128) -> Result<()> {
        self.call(
            from,
            self.core,
            ICore::repayCall {
                poolId: pool,
                units: U256::from(units).to(),
            },
            "repay",
        )
        .map(|_| ())
    }
    pub fn close_window(&mut self, pool: B256) -> Result<bool> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::closeWindowCall {
                poolId: pool,
                maxBids: U256::from(1000),
            },
            "closeWindow",
        )
    }
    pub fn claim(&mut self, from: Address, pool: B256) -> Result<(U256, U256)> {
        let r = self.call(from, self.core, ICore::claimCall { poolId: pool }, "claim")?;
        Ok((r._0, r._1))
    }
    pub fn withdraw(&mut self, from: Address, token: Address) -> Result<U256> {
        self.call(
            from,
            self.core,
            ICore::withdrawCall { token, to: from },
            "withdraw",
        )
    }
    pub fn pool_view(&mut self, pool: B256) -> Result<PoolView> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::poolCall { poolId: pool },
            "pool",
        )
    }
    pub fn pending(&mut self, token: Address, who: Address) -> Result<U256> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::pendingCall {
                token,
                account: who,
            },
            "pending",
        )
    }
    pub fn vwap(&mut self, pool: B256) -> Result<U256> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::vwapCall { poolId: pool },
            "vwap",
        )
    }
    pub fn bid(&mut self, from: Address, pool: B256, units: u128, premium: u128) -> Result<u64> {
        self.call(
            from,
            self.core,
            ICore::bidCall {
                poolId: pool,
                units: U256::from(units).to(),
                surplusPerUnit: U256::from(premium).to(),
                hint: 0,
            },
            "bid",
        )
    }
    pub fn rollover(
        &mut self,
        from: Address,
        old: B256,
        new: B256,
        units: u128,
        min_price: u128,
        max_top_up: u128,
        ttl: u16,
    ) -> Result<u64> {
        self.call(
            from,
            self.core,
            ICore::rolloverCall {
                oldPoolId: old,
                newPoolId: new,
                units: U256::from(units).to(),
                minPrice: U256::from(min_price).to(),
                maxTopUp: U256::from(max_top_up).to(),
                ttl,
                hint: 0,
            },
            "rollover",
        )
    }
    pub fn cancel(&mut self, from: Address, pool: B256, id: u64) -> Result<()> {
        self.call(
            from,
            self.core,
            ICore::cancelOrderCall {
                poolId: pool,
                orderId: id,
            },
            "cancelOrder",
        )
        .map(|_| ())
    }
    /// Deploys a MockFlashBorrower (repays when `repay`), funds it with `fee_budget` of `token`, and borrows.
    pub fn flash_loan(
        &mut self,
        token: Address,
        amount: u128,
        repay: bool,
        fee_budget: u128,
    ) -> Result<u64> {
        let code = link(&artifact("MockFlashBorrower")?, &[])?;
        let b = self.deploy(addr(0xdead), code, "MockFlashBorrower")?;
        self.call(
            addr(0xdead),
            token,
            IERC20::mintCall {
                to: b,
                amount: U256::from(fee_budget),
            },
            "mint",
        )?;
        if !repay {
            self.call(
                addr(0xdead),
                b,
                IFlashBorrower::setRepayCall { r: false },
                "setRepay",
            )?;
        }
        self.call(
            addr(0xbeef),
            self.core,
            ICore::flashLoanCall {
                receiver: b,
                token,
                amount: U256::from(amount),
                data: Bytes::new(),
            },
            "flashLoan",
        )?;
        Ok(self.gas_used.last().unwrap().1)
    }
    pub fn flash_fees(&mut self, token: Address) -> Result<U256> {
        self.call(
            addr(0xbeef),
            self.core,
            ICore::flashFeesCall { token },
            "flashFees",
        )
    }
    /// Deploy any artifact in `artifacts/` with ABI-encoded constructor args appended.
    pub fn deploy_artifact(&mut self, name: &str, ctor_args: Vec<u8>) -> Result<Address> {
        let mut code = link(&artifact(name)?, &[])?;
        code.extend(ctor_args);
        self.deploy(addr(0xdead), code, name)
    }
    /// Raw call with pre-encoded calldata; returns the raw output or the decoded revert.
    pub fn raw_call(
        &mut self,
        from: Address,
        to: Address,
        data: Vec<u8>,
        label: &str,
    ) -> Result<Bytes> {
        let (out, gas, _) = self
            .tx(from, TxKind::Call(to), data)
            .with_context(|| label.to_string())?;
        self.gas_used.push((label.to_string(), gas));
        Ok(out)
    }
    /// `createPool` with explicit token addresses (hostile tokens).
    pub fn create_pool_tokens(
        &mut self,
        creator: Address,
        asset: Address,
        quote: Address,
        expiry: u64,
        strike: u128,
        fee_bps: u16,
        band_bps: u16,
    ) -> Result<B256> {
        let key = PoolKey {
            asset,
            quote,
            expiry,
            strike,
            kind: 0,
        };
        self.call(
            creator,
            self.core,
            ICore::createPoolCall {
                key,
                feeBps: fee_bps,
                bandBps: band_bps,
            },
            "createPool",
        )
    }
    pub fn place_in(
        &mut self,
        from: Address,
        pool: B256,
        side: u8,
        units: u128,
        limit: u128,
        ttl: u16,
    ) -> Result<u64> {
        let p = OrderParams {
            side,
            units: U256::from(units).to(),
            limit: U256::from(limit).to(),
            budget: U256::from(0u8).to(),
            ttl,
            hint: 0,
            owner: from,
        };
        self.call(
            from,
            self.core,
            ICore::placeOrderCall { poolId: pool, p },
            "placeOrder",
        )
    }
    pub fn book_count(&mut self, pool: B256, side: u8) -> Result<u32> {
        let r = self.call(
            addr(0xbeef),
            self.core,
            ICore::bookHeadCall { poolId: pool, side },
            "bookHead",
        )?;
        Ok(r._1)
    }
    pub fn last_gas(&self) -> u64 {
        self.gas_used.last().map(|g| g.1).unwrap_or(0)
    }

    /// ERC-6909 balance: C = poolId, R = poolId | 1.
    pub fn position(&mut self, who: Address, pool: B256, r: bool) -> Result<U256> {
        let mut id = U256::from_be_bytes(pool.0);
        if r {
            id |= U256::from(1);
        }
        self.call(
            addr(0xbeef),
            self.core,
            ICore::balanceOfCall { owner: who, id },
            "balanceOf6909",
        )
    }
}

fn decode_revert(b: &Bytes) -> String {
    if b.len() >= 4 {
        let sel = alloy_primitives::hex::encode(&b[..4]);
        if b.len() >= 68 && sel == "08c379a0" {
            if let Ok(s) = String::abi_decode(&b[4..]) {
                return s;
            }
        }
        return format!("selector 0x{sel}");
    }
    "empty".into()
}
