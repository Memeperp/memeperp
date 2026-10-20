(function (root, factory) {
  const safety = factory();
  if (typeof module === 'object' && module.exports) module.exports = safety;
  if (root) root.MemePerpWalletSafety = safety;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const EVM_READ_DISCOVERY = new Set([
    'eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'net_version',
  ]);
  const NETWORK_METHODS = new Set(['wallet_switchEthereumChain', 'wallet_addEthereumChain']);

  function reject() {
    throw new Error('Wallet operation blocked by MemePerp wallet-safety policy.');
  }

  function readablePersonalSignMessage(params) {
    if (!Array.isArray(params) || params.length !== 2) return false;
    const message = params[0];
    const account = params[1];
    if (typeof message !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(String(account || '')) ||
      !message || message.length > 12000 || /^[\s]*0x(?:[a-fA-F0-9]{2})+[\s]*$/.test(message)) return false;
    if (/^MemePerp testnet sign-in\nChain: (?:robinhood|bsc)\nWallet: 0x[a-fA-F0-9]{40}\nNonce: [a-fA-F0-9]{32}\nNo transaction or funds will be transferred\.$/.test(message)) {
      return message.split('\n')[2].slice(8).toLowerCase() === account.toLowerCase();
    }
    if (!message.startsWith('MemePerp Testnet Confirm ')) return false;
    return /^MemePerp Testnet Confirm [^\n]+\nChain: (?:robinhood|bsc)\nWallet: 0x[a-fA-F0-9]{40}\n[\s\S]*\nNonce: [a-f0-9-]{36}\nSimulated order only\. No on-chain transaction or wallet funds transfer\.$/.test(message) &&
      message.split('\n')[2].slice(8).toLowerCase() === account.toLowerCase();
  }

  function assertEvmRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.method !== 'string') reject();
    const { method, params } = request;
    if (EVM_READ_DISCOVERY.has(method)) {
      if (params != null && (!Array.isArray(params) || params.length !== 0)) reject();
      return true;
    }
    if (method === 'personal_sign') {
      if (!readablePersonalSignMessage(params)) reject();
      return true;
    }
    if (method === 'wallet_switchEthereumChain') {
      if (!Array.isArray(params) || params.length !== 1 ||
        !['0x1237', '0x38'].includes(String(params[0]?.chainId || '').toLowerCase())) reject();
      return true;
    }
    if (method === 'wallet_addEthereumChain') {
      const chain = params?.[0];
      if (!Array.isArray(params) || params.length !== 1 || !chain ||
        !['0x1237', '0x38'].includes(String(chain.chainId || '').toLowerCase()) ||
        !Array.isArray(chain.rpcUrls) || chain.rpcUrls.length !== 1 ||
        !chain.nativeCurrency || chain.nativeCurrency.decimals !== 18) reject();
      const expected = String(chain.chainId).toLowerCase() === '0x1237'
        ? { name: 'Robinhood Chain', symbols: ['ETH'], names: ['ETH', 'Ether'], rpc: 'https://rpc.mainnet.chain.robinhood.com' }
        : { name: 'BNB Smart Chain', symbols: ['BNB'], names: ['BNB'], rpc: 'https://bsc-dataseed.bnbchain.org' };
      if (chain.chainName !== expected.name || chain.rpcUrls[0] !== expected.rpc ||
        !expected.names.includes(chain.nativeCurrency.name) ||
        !expected.symbols.includes(chain.nativeCurrency.symbol)) reject();
      return true;
    }
    reject();
  }

  function requestEvm(provider, request) {
    assertEvmRequest(request);
    if (!provider || typeof provider.request !== 'function') reject();
    return provider.request(request);
  }

  function solanaMessageBytes(message) {
    const login = typeof message === 'string' &&
      /^MemePerp Testnet Login\nWallet: [1-9A-HJ-NP-Za-km-z]{32,44}\nNonce: [a-f0-9]{32}\nIssued At: [^\n]+\nLogin only\. No transaction or funds will be transferred\.$/.test(message);
    const admin = typeof message === 'string' &&
      /^MemePerp Beta Admin Access\nWallet: [1-9A-HJ-NP-Za-km-z]{32,44}\nNonce: [a-f0-9]{32}\nIssued At: [^\n]+\nAdmin access only\. No transaction or funds will be transferred\.$/.test(message);
    const confirmation = typeof message === 'string' &&
      /^MemePerp (?:Testnet|Mainnet) Simulation Confirmation\nAction: [^\n]+\nDetails: [^\n]*\nNonce: \d+\nSimulation only\. No on-chain transaction or wallet funds transfer\.$/.test(message);
    const connection = typeof message === 'string' &&
      /^MemePerp Connect Confirmation\nNonce: \d+\nConnection only\. No transaction or funds will be transferred\.$/.test(message);
    const serverConfirmation = typeof message === 'string' &&
      /^MemePerp Testnet Confirm [^\n]+\nChain: solana\nWallet: [1-9A-HJ-NP-Za-km-z]{32,44}\nParameters: [^\n]+\nNonce: [a-f0-9-]{36}\nExpires At: [^\n]+\nSimulated action only\. No on-chain transaction or wallet funds transfer\.$/.test(message);
    if (typeof message !== 'string' || message.length > 12000 || !(login || admin || confirmation || connection || serverConfirmation)) reject();
    return new TextEncoder().encode(message);
  }

  async function signSolanaMessage(provider, message) {
    if (!provider || typeof provider.signMessage !== 'function') {
      throw new Error('Wallet provider does not support safe readable message signing.');
    }
    return provider.signMessage(solanaMessageBytes(message), 'utf8');
  }

  return { assertEvmRequest, requestEvm, readablePersonalSignMessage, signSolanaMessage, solanaMessageBytes };
});