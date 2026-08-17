pragma solidity >=0.5.0;

interface IUniswapV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint);
    event SwapFeeUpdated(uint32 oldSwapFee, uint32 newSwapFee);

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);

    // Trading fee in hundredths of a percent: 25 = 0.25%. Every pair reads this on
    // every swap, so changing it changes the fee everywhere at once.
    function swapFee() external view returns (uint32);
    function MAX_SWAP_FEE() external view returns (uint32);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
    function setSwapFee(uint32) external;
}
