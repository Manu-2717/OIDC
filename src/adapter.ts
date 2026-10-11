import type { Adapter, AdapterPayload } from "oidc-provider";
import { GRANT_INDEX_TTL } from "./lifetimes.js";
import type { Op, StateBackend } from "./state.js";

/**
 * The provider's storage, kept in the short-lived state store (Redis). The provider keeps a handful of kinds of records (sessions, sign ins
 * in progress, authorization codes, tokens, grants), each with its own lifetime, and Redis expires them by itself.
 *
 * Layout. Every write is one `SET ... EX`, so a record can never exist without a lifetime, and most writes are a single command:
 *  - `oidc:<model>:<id>`        the record, as JSON,
 *  - `oidc:<model>:<id>:c`      when it was consumed, if it has been (a code that is used is kept, marked, so a replay can be recognised),
 *  - `oidc:grant:<grantId>`     the set of records belonging to a grant, so signing out or revoking removes them all at once,
 *  - `oidc:uid:<uid>`           a session's fixed identifier, which the provider looks sessions up by.
 */

const key = (model: string, id: string) => `oidc:${model}:${id}`;
const consumedKey = (model: string, id: string) => `${key(model, id)}:c`;
const grantKey = (grantId: string) => `oidc:grant:${grantId}`;
const uidKey = (uid: string) => `oidc:uid:${uid}`;

/** A consumed marker outlives the record it belongs to, which is what lets a replayed code be told apart from an unknown one. */
const CONSUMED_TTL = 60 * 60;

export function createAdapter(state: StateBackend): new (model: string) => Adapter {
  return class StateAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      // The provider always passes a lifetime. A record without one would live forever, so refuse rather than guess.
      if (!expiresIn || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error(`No lifetime for ${this.model} ${id}`);
      const seconds = Math.ceil(expiresIn);
      const k = key(this.model, id);
      const grantId = typeof payload.grantId === "string" ? payload.grantId : undefined;
      const uid = typeof payload.uid === "string" ? payload.uid : undefined;

      const ops: Op[] = [{ t: "set", key: k, value: JSON.stringify(payload), ex: seconds }];
      if (grantId) {
        ops.push({ t: "sadd", key: grantKey(grantId), member: k });
        ops.push({ t: "expire", key: grantKey(grantId), seconds: Math.max(seconds, GRANT_INDEX_TTL) });
      }
      if (uid) ops.push({ t: "set", key: uidKey(uid), value: id, ex: seconds });
      await state.exec(ops);
    }

    async find(id: string) {
      // Apps are registered in code, never in storage: do not spend a Redis call on a client lookup.
      if (this.model === "Client") return undefined;
      const [payload, consumed] = await state.mget([key(this.model, id), consumedKey(this.model, id)]);
      if (!payload) return undefined;
      const parsed = JSON.parse(payload) as AdapterPayload;
      if (consumed) parsed.consumed = Number(consumed);
      return parsed;
    }

    async findByUid(uid: string) {
      const id = await state.get(uidKey(uid));
      return id ? this.find(id) : undefined;
    }

    async findByUserCode(_userCode: string) {
      // The device flow is not enabled.
      return undefined;
    }

    async consume(id: string) {
      await state.exec([{ t: "set", key: consumedKey(this.model, id), value: String(Math.floor(Date.now() / 1000)), ex: CONSUMED_TTL }]);
    }

    async destroy(id: string) {
      await state.exec([
        { t: "del", key: key(this.model, id) },
        { t: "del", key: consumedKey(this.model, id) },
      ]);
    }

    async revokeByGrantId(grantId: string) {
      const members = await state.smembers(grantKey(grantId));
      await state.exec([...members.map((member): Op => ({ t: "del", key: member })), { t: "del", key: grantKey(grantId) }]);
    }
  };
}
