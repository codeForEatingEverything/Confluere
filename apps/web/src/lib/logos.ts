/**
 * Official token and chain marks, bundled under public/ (no runtime CDN). Sources: monad-crypto/token-list (MON,
 * WMON, USDC, shMON), Trust Wallet assets (HYPE / HyperEVM, ETH / Ethereum, wstETH), CoinGecko (kHYPE). Keyed by chain +
 * lowercased address; native coins use the zero address. Wrapped native tokens use the native mark (WHYPE = HYPE,
 * WMON = MON, WETH = ETH); ui TokenIcon adds a small "W" mark on every WHYPE / WMON / WETH icon, so the coin and its
 * wrapped token read as two tokens of one coin. Sepolia's chain mark is Ethereum's.
 */
const ZERO = "0x0000000000000000000000000000000000000000";

const TOKENS: Record<number, Record<string, string>> = {
  10143: {
    [ZERO]: "/tokens/10143/0x0000000000000000000000000000000000000000.svg",
    // WMON uses the MON logo; TokenIcon adds the small "W" mark (WMON is its own token, separate from MON)
    "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541": "/tokens/10143/0x0000000000000000000000000000000000000000.svg",
    "0x534b2f3a21130d7a60830c2df862319e593943a3": "/tokens/10143/0x534b2f3a21130d7a60830c2df862319e593943a3.svg",
    "0x282bddff5e58793acab65438b257dbd15a8745c9": "/tokens/10143/0x282bddff5e58793acab65438b257dbd15a8745c9.png",
  },
  998: {
    [ZERO]: "/tokens/998/0x0000000000000000000000000000000000000000.png",
    "0x5555555555555555555555555555555555555555": "/tokens/998/0x0000000000000000000000000000000000000000.png", // WHYPE: the HYPE logo plus the "W" mark (ui TokenIcon)
    "0x2b3370ee501b4a559b57d449569354196457d8ab": "/tokens/998/0x2b3370ee501b4a559b57d449569354196457d8ab.svg",
    // kHYPE (Kinetiq staked HYPE, CoinGecko's mark); the address is the demo's (lib/demo/deployments DEMO_ADDR.khype)
    "0xd3a0000000000000000000000000000000000a01": "/tokens/998/0xd3a0000000000000000000000000000000000a01.png",
  },
  11155111: {
    [ZERO]: "/tokens/11155111/0x0000000000000000000000000000000000000000.png",
    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": "/tokens/11155111/0x0000000000000000000000000000000000000000.png", // WETH: the ETH logo plus the "W" mark
    "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": "/tokens/11155111/0x1c7d4b196cb0c7b01d743fbc6116a902379c7238.svg",
    "0xb82381a3fbd3fafa77b3a7be693342618240067b": "/tokens/11155111/0xb82381a3fbd3fafa77b3a7be693342618240067b.png",
  },
};

/** Symbol fallback for callers that only know the symbol, and for local mocks with the same symbols (anvil). */
const BY_SYMBOL: Record<string, string> = {
  MON: TOKENS[10143]![ZERO]!,
  WMON: TOKENS[10143]!["0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541"]!,
  SHMON: TOKENS[10143]!["0x282bddff5e58793acab65438b257dbd15a8745c9"]!,
  USDC: TOKENS[10143]!["0x534b2f3a21130d7a60830c2df862319e593943a3"]!,
  HYPE: TOKENS[998]![ZERO]!,
  WHYPE: TOKENS[998]!["0x5555555555555555555555555555555555555555"]!,
  KHYPE: TOKENS[998]!["0xd3a0000000000000000000000000000000000a01"]!,
  ETH: TOKENS[11155111]![ZERO]!,
  WETH: TOKENS[11155111]!["0xfff9976782d46cc05630d1f6ebab18b2324d6b14"]!,
  WSTETH: TOKENS[11155111]!["0xb82381a3fbd3fafa77b3a7be693342618240067b"]!,
};

export function tokenLogo(chainId: number | undefined, address?: string, symbol?: string): string | undefined {
  if (address && chainId !== undefined) {
    const hit = TOKENS[chainId]?.[address.toLowerCase()];
    if (hit) return hit;
  }
  return symbol ? BY_SYMBOL[symbol.toUpperCase()] : undefined;
}

/** The token list's own wrapped-MON mark, kept for reference; the UI draws a small badge instead. */
export const WRAPPED_MARK_WMON = "/tokens/10143/0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541.svg";

const CHAINS: Record<number, string> = { 10143: "/chains/10143.svg", 998: "/chains/998.png", 11155111: "/chains/11155111.png" };
export const chainLogo = (id: number): string | undefined => CHAINS[id];

const NAMES: Record<string, string> = { MON: "Monad", WMON: "Wrapped MON", SHMON: "FastLane staked MON", USDC: "USD Coin", HYPE: "Hyperliquid", WHYPE: "Wrapped HYPE", KHYPE: "Kinetiq staked HYPE", ETH: "Ether", WETH: "Wrapped Ether", WSTETH: "Lido wrapped staked ETH" };
/** Full token name for selector rows (launch tokens); undefined for others. */
export const tokenName = (symbol?: string) => (symbol ? NAMES[symbol.toUpperCase()] : undefined);
