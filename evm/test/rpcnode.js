// A read-only JSON-RPC front end for the in-process test chain.
//
// The export tool talks to a real node over HTTP -- eth_call, eth_getLogs, the
// lot -- so testing it end to end needs something at the other end of a socket.
// Rather than add a node binary (ganache ships no native module for Node 22 and
// its JS fallback resets connections; anvil would mean installing a toolchain),
// this serves the SAME @ethereumjs/evm chain the rest of the suite already runs
// against. Real bytecode, real logs, real HTTP, no new dependency.
//
// Read-only is not a shortcut: `export-compliance.js` never writes. Deployment
// and configuration happen in-process through the harness, exactly as in every
// other test here, and only the reads go over the wire.
//
// Supported: eth_chainId, net_version, eth_blockNumber, eth_getBlockByNumber,
// eth_call, eth_getLogs. Anything else returns a "method not supported" error
// rather than a plausible lie, so a tool relying on something unimplemented
// fails loudly instead of silently reading zeros.

const http = require('http');
const { hexToBytes, bytesToHex, Address } = require('@ethereumjs/util');

const CHAIN_ID = '0x539'; // 1337
const pad32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

function blockTag(tag, latest) {
  if (tag === undefined || tag === null || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') {
    return latest;
  }
  if (tag === 'earliest') return 0;
  return Number(BigInt(tag));
}

/// Does one recorded log match an eth_getLogs filter?
function matches(log, filter, from, to) {
  if (log.blockNumber < from || log.blockNumber > to) return false;

  if (filter.address) {
    const wanted = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) =>
      a.toLowerCase()
    );
    if (!wanted.includes(log.address.toLowerCase())) return false;
  }

  // Topic positions are AND-ed; a null matches anything, and an array at a
  // position is an OR over its entries. Same semantics as a real node.
  const topics = filter.topics || [];
  for (let i = 0; i < topics.length; i++) {
    const want = topics[i];
    if (want === null || want === undefined) continue;
    const have = log.topics[i];
    if (have === undefined) return false;
    const options = (Array.isArray(want) ? want : [want]).map((t) => t.toLowerCase());
    if (!options.includes(have.toLowerCase())) return false;
  }
  return true;
}

/// Start an HTTP JSON-RPC server in front of `chain`. Returns { url, close }.
async function serve(chain) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (_) {
        res.writeHead(400).end('bad json');
        return;
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const call of batch) out.push(await handle(chain, call));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(payload) ? out : out[0]));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function handle(chain, { id, method, params = [] }) {
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (message) => ({ jsonrpc: '2.0', id, error: { code: -32601, message } });

  switch (method) {
    case 'eth_chainId':
      return reply(CHAIN_ID);
    case 'net_version':
      return reply('1337');
    case 'eth_blockNumber':
      return reply('0x' + chain.blockNumber.toString(16));

    case 'eth_getBlockByNumber': {
      const n = blockTag(params[0], chain.blockNumber);
      return reply({
        number: '0x' + n.toString(16),
        hash: pad32(n),
        parentHash: pad32(n === 0 ? 0 : n - 1),
        timestamp: '0x' + (1700000000 + n).toString(16),
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        miner: '0x' + '00'.repeat(20),
        baseFeePerGas: '0x0',
        transactions: [],
      });
    }

    case 'eth_call': {
      const { to, data, from } = params[0] || {};
      if (!to) return reply('0x');
      // Checkpoint/revert so a call that does write cannot alter the chain the
      // rest of the test is asserting against.
      await chain.evm.stateManager.checkpoint();
      try {
        const result = await chain.evm.runCall({
          to: new Address(hexToBytes(to)),
          caller: from ? new Address(hexToBytes(from)) : chain.account(1),
          data: data ? hexToBytes(data) : new Uint8Array(),
          gasLimit: 100000000n,
        });
        if (result.execResult.exceptionError) {
          const ret = bytesToHex(result.execResult.returnValue);
          return {
            jsonrpc: '2.0',
            id,
            error: { code: 3, message: 'execution reverted', data: ret },
          };
        }
        return reply(bytesToHex(result.execResult.returnValue));
      } finally {
        await chain.evm.stateManager.revert();
      }
    }

    case 'eth_getLogs': {
      const filter = params[0] || {};
      const from = blockTag(filter.fromBlock, 0);
      const to = blockTag(filter.toBlock, chain.blockNumber);
      const found = chain.logs.filter((l) => matches(l, filter, from, to));
      return reply(
        found.map((l, i) => ({
          address: l.address,
          topics: l.topics,
          data: l.data === '0x' ? '0x' : l.data,
          blockNumber: '0x' + l.blockNumber.toString(16),
          blockHash: pad32(l.blockNumber),
          transactionHash: pad32(l.blockNumber),
          transactionIndex: '0x0',
          logIndex: '0x' + i.toString(16),
          removed: false,
        }))
      );
    }

    default:
      return fail(`rpcnode: method not supported: ${method}`);
  }
}

module.exports = { serve };
