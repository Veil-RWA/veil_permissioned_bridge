// The cash relayer as a Lambda, deployed the way HyperVeil's keeper is.
// EventBridge calls this every minute; one invocation runs one pass of
// relay-cash.js: new burns to the vault, Circle's attestations relayed, held
// deposits retried.
//
// Two guards, as in the keeper:
//   * a DynamoDB lock, so two invocations never send transactions from the
//     relayer account at once. An invocation that finds it held returns.
//   * the lock expires on its own, so a crashed or timed-out pass does not
//     wedge the relayer.
//
// The progress (blocks read, deposits pending and held) is one item, `state`.
// All of it can be rebuilt from the chains, so losing it costs a rescan, not a
// deposit. The deployment it serves is bundled next to this file by deploy.sh.

const fs = require('fs');
const path = require('path');
const {
  DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { createRelayer, emptyState } = require('../relay-cash');

const STATE_PK = 'state';
const LOCK_PK = 'lock';
/** Above the function's own timeout, so a timed-out pass cannot be overlapped
 *  by the next schedule. */
const LOCK_MS = Number(process.env.RELAY_LOCK_MS ?? 6 * 60 * 1000);

exports.handler = async () => {
  const table = process.env.RELAY_STATE_TABLE;
  if (!table) throw new Error('missing RELAY_STATE_TABLE');
  const ddb = new DynamoDBClient({});
  const owner = `${process.pid}-${Date.now()}-${Math.random()}`;

  const now = Date.now();
  try {
    await ddb.send(new PutItemCommand({
      TableName: table,
      Item: { pk: { S: LOCK_PK }, until: { N: String(now + LOCK_MS) }, owner: { S: owner } },
      ConditionExpression: 'attribute_not_exists(pk) OR #u < :now',
      ExpressionAttributeNames: { '#u': 'until' },
      ExpressionAttributeValues: { ':now': { N: String(now) } },
    }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      console.log('another pass holds the lock; skipping');
      return { ok: true, skipped: 'locked' };
    }
    throw e;
  }

  try {
    const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8'));
    const relayer = await createRelayer({
      deployment,
      evmNetwork: process.env.RELAY_EVM ?? 'ethereum-sepolia',
      starknetNetwork: process.env.RELAY_STARKNET ?? 'starknet-sepolia',
    });
    const got = await ddb.send(new GetItemCommand({
      TableName: table, Key: { pk: { S: STATE_PK } }, ConsistentRead: true,
    }));
    const st = got.Item?.json?.S ? JSON.parse(got.Item.json.S) : emptyState();
    await relayer.pass(st, (s) => ddb.send(new PutItemCommand({
      TableName: table,
      Item: { pk: { S: STATE_PK }, json: { S: JSON.stringify(s) }, at: { N: String(Date.now()) } },
    })));
    return { ok: true };
  } finally {
    await ddb.send(new DeleteItemCommand({
      TableName: table,
      Key: { pk: { S: LOCK_PK } },
      ConditionExpression: '#o = :me',
      ExpressionAttributeNames: { '#o': 'owner' },
      ExpressionAttributeValues: { ':me': { S: owner } },
    })).catch((e) => {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    });
  }
};
