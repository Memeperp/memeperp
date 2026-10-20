const test = require('node:test');
const assert = require('node:assert/strict');
const safety = require('./walletSafety');

const address = `0x${'1'.repeat(40)}`;
const loginMessage = `MemePerp testnet sign-in\nChain: bsc\nWallet: ${address}\nNonce: ${'a'.repeat(32)}\nNo transaction or funds will be transferred.`;
const actionMessage = `MemePerp Testnet Confirm ADD TEST BALANCE\nChain: bsc\nWallet: ${address}\nAmount: $25 USD (converted to BNB at the live quote)\nNonce: 00000000-0000-4000-8000-000000000001\nSimulated order only. No on-chain transaction or wallet funds transfer.`;

function fakeWallet() {
  return {
    requests: [],
    async request(request) {
      this.requests.push(request);
      return true;
    },
  };
}

test('EVM policy admits discovery, network setup, and readable backend-shaped login/action signatures', async () => {
  const wallet = fakeWallet();
  const allowed = [
    { method: 'eth_accounts' },
    { method: 'eth_requestAccounts' },
    { method: 'eth_chainId' },
    { method: 'net_version' },
    { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] },
    { method: 'wallet_addEthereumChain', params: [{
      chainId: '0x38', chainName: 'BNB Smart Chain', rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    }] },
    { method: 'personal_sign', params: [loginMessage, address] },
    { method: 'personal_sign', params: [actionMessage, address] },
  ];
  for (const request of allowed) await safety.requestEvm(wallet, request);
  assert.equal(wallet.requests.length, allowed.length);
});

test('EVM policy rejects transaction, approval, typed-data, digest, and unknown wallet operations before provider access', async () => {
  const wallet = fakeWallet();
  const forbidden = [
    'eth_sendTransaction', 'eth_signTransaction', 'eth_sendRawTransaction',
    'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4',
    'wallet_signTypedData', 'eth_sendUserOperation', 'personal_sign',
    'unknown_wallet_method',
  ];
  for (const method of forbidden) {
    assert.throws(() => safety.requestEvm(wallet, {
      method,
      params: method === 'personal_sign' ? [`0x${'ab'.repeat(32)}`, address] : [],
    }), /wallet-safety policy/);
  }
  for (const message of [
    `Sign this arbitrary message`,
    `0x${'ab'.repeat(32)}`,
    `MemePerp testnet sign-in\nChain: bsc\nWallet: ${address}\nNonce: ${'a'.repeat(32)}\nNo transaction or funds will be transferred.\nApprove token`,
    actionMessage.replace('No on-chain transaction or wallet funds transfer.', 'Approve spending'),
  ]) {
    assert.throws(() => safety.requestEvm(wallet, {
      method: 'personal_sign', params: [message, address],
    }), /wallet-safety policy/);
  }
  assert.equal(wallet.requests.length, 0);
});

test('Solana signing accepts only app-readable login/simulation messages and never falls back to transaction signing', async () => {
  let calls = 0;
  const provider = {
    async signMessage(bytes, encoding) {
      calls++;
      assert.equal(encoding, 'utf8');
      const decoded = new TextDecoder().decode(bytes);
      assert.match(decoded, /^MemePerp (?:Testnet Login|Testnet Simulation Confirmation)\n/);
      return { signature: new Uint8Array([1, 2, 3]) };
    },
  };
  await safety.signSolanaMessage(provider, [
    'MemePerp Testnet Login',
    `Wallet: ${'1'.repeat(32)}`,
    `Nonce: ${'a'.repeat(32)}`,
    'Issued At: 2026-01-01T00:00:00.000Z',
    'Login only. No transaction or funds will be transferred.',
  ].join('\n'));
  await safety.signSolanaMessage(provider, [
    'MemePerp Testnet Simulation Confirmation',
    'Action: close',
    'Details: simulated',
    'Nonce: 123',
    'Simulation only. No on-chain transaction or wallet funds transfer.',
  ].join('\n'));
  assert.equal(calls, 2);
  await assert.rejects(safety.signSolanaMessage({ signTransaction() {} }, 'arbitrary'));
  assert.equal(calls, 2);
});

test('beta-admin login remains message-only and rejects arbitrary or spending payloads', async () => {
  const calls = [];
  const provider = {
    async signMessage(bytes) {
      calls.push(new TextDecoder().decode(bytes));
      return { signature: new Uint8Array([1, 2, 3]) };
    },
    signTransaction() { throw new Error('Transactions must never be requested'); },
  };
  const message = [
    'MemePerp Beta Admin Access',
    `Wallet: ${'1'.repeat(32)}`,
    `Nonce: ${'a'.repeat(32)}`,
    'Issued At: 2026-01-01T00:00:00.000Z',
    'Admin access only. No transaction or funds will be transferred.',
  ].join('\n');
  await safety.signSolanaMessage(provider, message);
  assert.deepEqual(calls, [message]);
  for (const unsafe of [message + '\nApprove spending', 'arbitrary bytes', '0xdeadbeef']) {
    await assert.rejects(safety.signSolanaMessage(provider, unsafe), /wallet-safety policy/);
  }
  assert.equal(calls.length, 1);
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const compat = source.match(/function signMessageCompat\(provider, messageBytes\) \{([\s\S]*?)\n\}/)[1];
  assert.match(compat, /MemePerpWalletSafety\.signSolanaMessage/);
  assert.doesNotMatch(compat, /provider\.signMessage\s*\(/);
});