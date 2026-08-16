module.exports = {
  skipFiles: [
    "mocks/",
    "TransactVerifier.sol",
    "Create2Factory.sol",
    "interfaces/",
  ],
  mocha: {
    timeout: 300000, // 5 min — ZK proof tests are slow under coverage instrumentation
  },
};
