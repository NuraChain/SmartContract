pragma solidity =0.5.16;

import './interfaces/IUniswapV2Factory.sol';
import './UniswapV2Pair.sol';

contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;

    // The trading fee, in hundredths of a percent, shared by every pair: 25 = 0.25%.
    // Upstream UniswapV2 hardcodes this in the pair bytecode; here it is storage, so
    // feeToSetter can retune it after launch without redeploying anything.
    uint32 public swapFee = 25;

    // A ceiling the setter cannot exceed, and the only thing standing between a
    // compromised feeToSetter and a fee that confiscates the whole trade. It is
    // `constant`, so it is baked into the bytecode and cannot itself be raised —
    // lifting it means deploying a new factory, which is the point.
    uint32 public constant MAX_SWAP_FEE = 100; // 1.00%

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);
    event SwapFeeUpdated(uint32 oldSwapFee, uint32 newSwapFee);

    constructor(address _feeToSetter) public {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'UniswapV2: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'UniswapV2: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'UniswapV2: PAIR_EXISTS'); // single check is sufficient
        bytes memory bytecode = type(UniswapV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        IUniswapV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }

    // Takes effect on the very next swap, in every pair at once. Raising it makes the
    // pairs' K check stricter, so swaps already in the mempool quoted at the old rate
    // revert rather than underpay - unpleasant for those traders, but never a loss to
    // the pool. Lowering it only loosens the check, so nothing in flight breaks.
    function setSwapFee(uint32 _swapFee) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        require(_swapFee <= MAX_SWAP_FEE, 'UniswapV2: SWAP_FEE_TOO_HIGH');
        emit SwapFeeUpdated(swapFee, _swapFee);
        swapFee = _swapFee;
    }
}
