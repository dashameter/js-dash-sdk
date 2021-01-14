import { expect } from 'chai';
import { Client } from "./index";
import 'mocha';
import { Transaction } from "@dashevo/dashcore-lib";
import { createFakeInstantLock } from "../../utils/createFakeIntantLock";
import stateTransitionTypes from '@dashevo/dpp/lib/stateTransition/stateTransitionTypes';
import { StateTransitionBroadcastError } from '../../errors/StateTransitionBroadcastError';

// @ts-ignore
const getDocumentsFixture = require('@dashevo/dpp/lib/test/fixtures/getDocumentsFixture');
// @ts-ignore
const getDataContractFixture = require('@dashevo/dpp/lib/test/fixtures/getDataContractFixture');

import { createIdentityFixtureInAccount } from '../../test/fixtures/createIdentityFixtureInAccount';
import { createTransactionInAccount } from '../../test/fixtures/createTransactionFixtureInAccount';
import { createAndAttachTransportMocksToClient } from '../../test/mocks/createAndAttachTransportMocksToClient';

describe('Dash - Client', function suite() {
  this.timeout(30000);

  let testMnemonic;
  let txStreamMock;
  let transportMock;
  let testHDKey;
  let client;
  let account;
  let walletTransaction;
  let dapiClientMock;
  let identityFixture;
  let documentsFixture;
  let dataContractFixture;

  beforeEach(async function beforeEach() {
    testMnemonic = 'agree country attract master mimic ball load beauty join gentle turtle hover';
    testHDKey = "xprv9s21ZrQH143K4PgfRZPuYjYUWRZkGfEPuWTEUESMoEZLC274ntC4G49qxgZJEPgmujsmY52eVggtwZgJPrWTMXmbYgqDVySWg46XzbGXrSZ";

    client = new Client({
      wallet: {
        HDPrivateKey: testHDKey,
      }
    });

    ({ txStreamMock, transportMock, dapiClientMock } = await createAndAttachTransportMocksToClient(client, this.sinon));

    account = await client.getWalletAccount();

    // add fake tx to the wallet so it will be able to create transactions
    walletTransaction = createTransactionInAccount(account);
    // create an identity in the account so we can sign state transitions
    identityFixture = createIdentityFixtureInAccount(account);
    dataContractFixture = getDataContractFixture();
    documentsFixture = getDocumentsFixture(dataContractFixture);

    dapiClientMock.platform.getIdentity.resolves(identityFixture.toBuffer());
    dapiClientMock.platform.getDataContract.resolves(dataContractFixture.toBuffer());
  });

  it('should provide expected class', function () {
    expect(Client.name).to.be.equal('Client');
    expect(Client.constructor.name).to.be.equal('Function');
  });
  it('should be instantiable', function () {
    const client = new Client();
    expect(client).to.exist;
    expect(client.network).to.be.equal('testnet');
    expect(client.getDAPIClient().constructor.name).to.be.equal('DAPIClient');
  });
  it('should not initiate wallet lib without mnemonic', function () {
    const client = new Client();
    expect(client.wallet).to.be.equal(undefined);
  });
  it('should initiate wallet-lib with a mnemonic', async ()=>{
    const client = new Client({
      wallet: {
        mnemonic: testMnemonic,
        offlineMode: true,
      }
    });
    expect(client.wallet).to.exist;
    expect(client.wallet!.offlineMode).to.be.equal(true);

    await client.wallet?.storage.stopWorker();
    await client.wallet?.disconnect();

    const account = await client.getWalletAccount();
    await account.disconnect();
  });
  it('should throw an error if client and wallet have different networks', async () => {
    try {
      new Client({
        network: 'testnet',
        wallet: {
          mnemonic: testMnemonic,
          offlineMode: true,
          network: 'evonet',
        },
      });

      expect.fail('should throw an error');
    } catch (e) {
      expect(e.message).to.equal('Wallet and Client networks are different');
    }
  });

  describe('#platform.identities.register', async () => {
    it('should register an identity', async () => {
      const accountIdentitiesCountBeforeTest = account.getIdentityIds().length;

      const identity = await client.platform.identities.register();

      expect(identity).to.be.not.null;

      const serializedSt = dapiClientMock.platform.broadcastStateTransition.getCall(0).args[0];
      const interceptedIdentityStateTransition = await client.platform.dpp.stateTransition.createFromBuffer(serializedSt);
      const interceptedAssetLock = interceptedIdentityStateTransition.getAssetLock();

      const transaction = new Transaction(transportMock.sendTransaction.getCall(0).args[0]);
      const isLock = createFakeInstantLock(transaction.hash);

      // Check intercepted st
      expect(interceptedAssetLock.getProof().getInstantLock()).to.be.deep.equal(isLock);
      expect(interceptedAssetLock.getTransaction().hash).to.be.equal(transaction.hash);

      const importedIdentityIds = account.getIdentityIds();
      // Check that we've imported identities properly
      expect(importedIdentityIds.length).to.be.equal(accountIdentitiesCountBeforeTest + 1);
      expect(importedIdentityIds[0]).to.be.equal(interceptedIdentityStateTransition.getIdentityId().toString());
    });

    it('should throw TransitionBroadcastError when transport resolves error', async () => {
      const accountIdentitiesCountBeforeTest = account.getIdentityIds().length;

      dapiClientMock.platform.waitForStateTransitionResult.resolves({ error: { code: 2, log: "Error happened" } });

      let error;
      try {
        await client.platform.identities.register();
      } catch (e) {
        error = e;
      }

      expect(error).to.be.an.instanceOf(StateTransitionBroadcastError);
      expect(error.getCode()).to.be.equal(2);
      expect(error.message).to.be.equal("Error happened");

      const importedIdentityIds = account.getIdentityIds();
      // Check that no identities were imported
      expect(importedIdentityIds.length).to.be.equal(accountIdentitiesCountBeforeTest);
    });
  });

  describe('#platform.identities.topUp', async () => {
    it('should top up an identity', async () => {
      // Registering an identity we're going to top up
      const identity = await client.platform.identities.register();
      // Topping up the identity
      await client.platform.identities.topUp(identity.getId(), 10000);

      expect(identity).to.be.not.null;

      const serializedSt = dapiClientMock.platform.broadcastStateTransition.getCall(1).args[0];
      const interceptedIdentityStateTransition = await client.platform.dpp.stateTransition.createFromBuffer(serializedSt);
      const interceptedAssetLock = interceptedIdentityStateTransition.getAssetLock();

      expect(interceptedIdentityStateTransition.getType()).to.be.equal(stateTransitionTypes.IDENTITY_TOP_UP);

      const transaction = new Transaction(transportMock.sendTransaction.getCall(1).args[0]);
      const isLock = createFakeInstantLock(transaction.hash);
      // Check intercepted st
      expect(interceptedAssetLock.getProof().getInstantLock()).to.be.deep.equal(isLock);
      expect(interceptedAssetLock.getTransaction().hash).to.be.equal(transaction.hash);
    });

    it('should throw TransitionBroadcastError when transport resolves error', async () => {
      // Registering an identity we're going to top up
      const identity = await client.platform.identities.register();

      dapiClientMock.platform.waitForStateTransitionResult.resolves({ error: { code: 2, log: "Error happened" } });

      let error;
      try {
        // Topping up the identity
        await client.platform.identities.topUp(identity.getId(), 10000);
      } catch (e) {
        error = e;
      }

      expect(error).to.be.an.instanceOf(StateTransitionBroadcastError);
      expect(error.getCode()).to.be.equal(2);
      expect(error.message).to.be.equal("Error happened");
    });
  });

  describe('#platform.documents.broadcast', () => {
    it('should throw TransitionBroadcastError when transport resolves error', async () => {
      dapiClientMock.platform.waitForStateTransitionResult.resolves({ error: { code: 2, log: "Error happened" } });

      let error;
      try {
        await client.platform.documents.broadcast({
          create: documentsFixture,
        }, identityFixture);
      } catch (e) {
        error = e;
      }

      expect(error).to.be.an.instanceOf(StateTransitionBroadcastError);
      expect(error.getCode()).to.be.equal(2);
      expect(error.message).to.be.equal("Error happened");
    });

    it('should broadcast documents', async () => {
      dapiClientMock.platform.waitForStateTransitionResult.resolves({ hash: '', proof: { code: 2, log: "Error happened" } });

      await client.platform.documents.broadcast({
        create: documentsFixture,
      }, identityFixture);

      const serializedSt = dapiClientMock.platform.broadcastStateTransition.getCall(0).args[0];
      const interceptedSt = await client.platform.dpp.stateTransition.createFromBuffer(serializedSt);

      expect(interceptedSt.verifySignature(identityFixture.getPublicKeyById(0))).to.be.true();

      const documentTransitions = interceptedSt.getTransitions();

      expect(documentTransitions.length).to.be.greaterThan(0);
      expect(documentTransitions.length).to.be.equal(documentsFixture.length);
    });
  });

  describe('#platform.contracts.broadcast', () => {
    it('should throw TransitionBroadcastError when transport resolves error', async () => {
      dapiClientMock.platform.waitForStateTransitionResult.resolves({ error: { code: 2, log: "Error happened" } });

      let error;
      try {
        await client.platform.contracts.broadcast(dataContractFixture, identityFixture);
      } catch (e) {
        error = e;
      }

      expect(error).to.be.an.instanceOf(StateTransitionBroadcastError);
      expect(error.getCode()).to.be.equal(2);
      expect(error.message).to.be.equal("Error happened");
    });

    it('should broadcast data contract', async () => {
      dapiClientMock.platform.waitForStateTransitionResult.resolves({ hash: '', proof: { code: 2, log: "Error happened" } });

      await client.platform.contracts.broadcast(dataContractFixture, identityFixture);

      const serializedSt = dapiClientMock.platform.broadcastStateTransition.getCall(0).args[0];
      const interceptedSt = await client.platform.dpp.stateTransition.createFromBuffer(serializedSt);

      expect(interceptedSt.verifySignature(identityFixture.getPublicKeyById(0))).to.be.true();
      expect(interceptedSt.getEntropy()).to.be.deep.equal(dataContractFixture.entropy);
      expect(interceptedSt.getDataContract().toObject()).to.be.deep.equal(dataContractFixture.toObject());
    });
  });
});
