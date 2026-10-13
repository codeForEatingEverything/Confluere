/** Testnet stand-in tokens (src/mocks/MockERC20.sol) expose a free mint for the demo faucet. */
export const mockErc20Abi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
