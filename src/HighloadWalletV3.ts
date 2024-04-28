import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, internal, MessageRelaxed, OutAction, OutActionSendMsg, Sender, SendMode, storeMessageRelaxed, storeOutList } from '@ton/core';
import { Maybe } from "@ton/core/dist/utils/maybe";
import { sign } from "ton-crypto";
import { HighloadQueryId } from "./HighloadQueryId";
import { TonClient, TonClientParameters } from '@ton/ton';

export type HighloadWalletV3Config = {
  publicKey: Buffer,
  walletId: number,
  timeout: number
};

export const DEFAULT_TIMEOUT = 60 * 60; // 1 hour
export const OPCODE_INTERNAL_TRANSFER = 0xae42e5a4;
export const TIMESTAMP_SIZE = 64;
export const TIMEOUT_SIZE = 22;

export class HighloadWalletV3 implements Contract {

  readonly workchain: number;
  readonly publicKey: Buffer;
  readonly address: Address;
  readonly walletId: number;
  readonly init: { data: Cell, code: Cell };
  readonly timeout: number;

  private constructor(workchain: number, publicKey: Buffer, walletId?: Maybe<number>, timeout?: Maybe<number>) {
    this.workchain = workchain;
    this.publicKey = publicKey;
    this.walletId = (walletId) ? walletId : 0x10ad;
    this.timeout = (timeout && (timeout > 0)) ? timeout : DEFAULT_TIMEOUT;

    // Construct initial code and data
    const code = Cell.fromBoc(Buffer.from("b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03", "hex"))[0];
    const data = beginCell()
      .storeBuffer(this.publicKey)
      .storeUint(this.walletId, 32)
      .storeUint(0, 1 + 1 + TIMESTAMP_SIZE)
      .storeUint(this.timeout, TIMEOUT_SIZE)
      .endCell();

    this.init = { code, data };
    this.address = contractAddress(workchain, { code, data });
  }

  static create(args: { workchain: number, publicKey: Buffer, walletId?: Maybe<number>, timeout?: Maybe<number> }): HighloadWalletV3 {
    return new HighloadWalletV3(args.workchain, args.publicKey, args.walletId, args.timeout);
  }

  static async createFromAddress(
    workchain: number,
    address: Address,
    tonClientParams: TonClientParameters,
    walletId?: Maybe<number>,
    timeout?: Maybe<number>
  ): Promise<HighloadWalletV3> {
    const client = new TonClient(tonClientParams);
    const { stack } = await client.runMethod(
      address,
      "get_public_key"
    );
    return new HighloadWalletV3(
      workchain,
      Buffer.from(stack.readBigNumber().toString(16).padStart(32 * 2, '0'), 'hex'),
      walletId,
      timeout
    );
  }

  static createFromConfig(config: HighloadWalletV3Config, workchain: number): HighloadWalletV3 {
    return new HighloadWalletV3(
      workchain,
      config.publicKey,
      config.walletId,
      config.timeout
    );
  }

  static generateQueryId(queryId: bigint): HighloadQueryId {
    return HighloadQueryId.fromQueryId(queryId);
  }

  async send(provider: ContractProvider, message: Cell) {
    await provider.external(message);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      bounce: false,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async sendExternalMessage(
    provider: ContractProvider,
    secretKey: Buffer,
    opts: {
      message: MessageRelaxed | Cell,
      mode: number,
      queryId: bigint | HighloadQueryId,
      createdAt: number,
      subwalletId: number,
      timeout: number,
    }
  ) {
    let messageCell: Cell;

    if (opts.message instanceof Cell) {
      messageCell = opts.message
    } else {
      const messageBuilder = beginCell();
      messageBuilder.store(storeMessageRelaxed(opts.message))
      messageCell = messageBuilder.endCell();
    }

    const queryId = (opts.queryId instanceof HighloadQueryId) ? opts.queryId.getQueryId() : opts.queryId;

    const messageInner = beginCell()
      .storeUint(opts.subwalletId, 32)
      .storeRef(messageCell)
      .storeUint(opts.mode, 8)
      .storeUint(queryId, 23)
      .storeUint(opts.createdAt, TIMESTAMP_SIZE)
      .storeUint(opts.timeout, TIMEOUT_SIZE)
      .endCell();

    await provider.external(
      beginCell()
        .storeBuffer(sign(messageInner.hash(), secretKey))
        .storeRef(messageInner)
        .endCell()
    );
  }

  async sendBatch(provider: ContractProvider, secretKey: Buffer, messages: OutActionSendMsg[], subwallet: number, queryId: HighloadQueryId, timeout: number, createdAt?: number, value: bigint = 0n) {
    if (createdAt == undefined) {
      createdAt = Math.floor(Date.now() / 1000);
    }
    return await this.sendExternalMessage(provider, secretKey, {
      message: this.packActions(messages, value, queryId),
      mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
      queryId: queryId,
      createdAt: createdAt,
      subwalletId: subwallet,
      timeout: timeout
    });
  }

  static createInternalTransferBody(opts: {
    actions: OutAction[] | Cell,
    queryId: HighloadQueryId,
  }) {
    let actionsCell: Cell;
    if (opts.actions instanceof Cell) {
      actionsCell = opts.actions;
    } else {
      if (opts.actions.length > 254) {
        throw TypeError("Max allowed action count is 254. Use packActions instead.");
      }
      const actionsBuilder = beginCell();
      storeOutList(opts.actions)(actionsBuilder);
      actionsCell = actionsBuilder.endCell();
    }
    return beginCell().storeUint(OPCODE_INTERNAL_TRANSFER, 32)
      .storeUint(opts.queryId.getQueryId(), 64)
      .storeRef(actionsCell)
      .endCell();
  }

  createInternalTransfer(opts: {
    actions: OutAction[] | Cell
    queryId: HighloadQueryId,
    value: bigint
  }) {

    return internal({
      to: this.address,
      value: opts.value,
      body: HighloadWalletV3.createInternalTransferBody(opts)
    });
    /*beginCell()
      .storeUint(0x10, 6)
      .storeAddress(this.address)
      .storeCoins(opts.value)
      .storeUint(0, 107)
      .storeSlice(body.asSlice())
      .endCell();
      */
  }

  packActions(messages: OutAction[], value: bigint, queryId: HighloadQueryId) {
    let batch: OutAction[];
    if (messages.length > 254) {
      batch = messages.slice(0, 253);
      batch.push({
        type: 'sendMsg',
        mode: value > 0n ? SendMode.PAY_GAS_SEPARATELY : SendMode.CARRY_ALL_REMAINING_BALANCE,
        outMsg: this.packActions(messages.slice(253), value, queryId)
      });
    } else {
      batch = messages;
    }
    return this.createInternalTransfer({
      actions: batch,
      queryId: queryId,
      value
    });
  }

  async getBalance(provider: ContractProvider): Promise<bigint> {
    const state = await provider.getState();
    return state.balance;
  }

  async getPublicKey(provider: ContractProvider): Promise<String> {
    const res = (await provider.get('get_public_key', [])).stack;
    const pubKeyU = res.readBigNumber();
    return pubKeyU.toString(16);
  }

  async getTimeout(provider: ContractProvider): Promise<number> {
    const res = (await provider.get('get_timeout', [])).stack;
    return res.readNumber();
  }

  async getLastCleaned(provider: ContractProvider): Promise<number> {
    const res = (await provider.get('get_last_clean_time', [])).stack;
    return res.readNumber();
  }

  async getProcessed(provider: ContractProvider, queryId: HighloadQueryId, needClean = true): Promise<boolean> {
    const res = (await provider.get('processed?', [{ 'type': 'int', 'value': queryId.getQueryId() }, {
      'type': 'int',
      'value': needClean ? -1n : 0n
    }])).stack;
    return res.readBoolean();
  }
}
