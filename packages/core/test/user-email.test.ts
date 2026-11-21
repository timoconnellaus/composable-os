// A staff member confirms their own address (ADR 0457), so the first admin (a password sign-up,
// unverified) can sign in by code. The address is the account's own: the code goes to it, so it
// cannot verify an address the person does not control, and a code sent to an address the account
// no longer has confirms nothing. A person only, own account only, not on MCP.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coreRegistry,
  type HostMail,
  type InvocationContext,
  invoke,
  staffMayGetCode,
} from "../src/index.ts";
import { auditChanges, context, createUser, db } from "./helpers.ts";

let owner: ActingUser;
const sent: { to: string; code: string }[] = [];
let mailProblem: string | null = null;

const hostMail: HostMail = {
  staffSignIn: "code",
  signInMailProblem: async () => mailProblem,
  sendSignInCode: async (message) => {
    sent.push(message);
  },
  sendStaffInvite: async () => "sent",
};

const as = (user: ActingUser, extra: Partial<InvocationContext> = {}) =>
  context(user, { hostMail, ...extra } as never);

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

const verified = async (id: string) =>
  (
    await env.DB.prepare("SELECT email_verified AS v FROM core_user WHERE id = ?")
      .bind(id)
      .first<{ v: number }>()
  )?.v;

/** A fresh unverified account, as the first admin's password sign-up leaves it. */
async function unverified(role: "admin" | "member" = "admin"): Promise<ActingUser> {
  const user = await createUser(role);
  await env.DB.prepare("UPDATE core_user SET email_verified = 0 WHERE id = ?").bind(user.id).run();
  return user;
}

/** Lets a new code be asked for at once (the resend wait is 30 seconds). */
const age = (id: string) =>
  env.DB.prepare("UPDATE core_email_confirmation SET created_at = ? WHERE user_id = ?")
    .bind(new Date(Date.now() - 60_000).toISOString(), id)
    .run();

beforeAll(async () => {
  owner = await unverified();
});
beforeEach(() => {
  sent.length = 0;
  mailProblem = null;
});

describe("confirming your own email address", () => {
  it("sends a code to your own address, and the right code confirms it", async () => {
    expect(await invoke("user.emailStatus", {}, as(owner))).toMatchObject({
      email: owner.email,
      verified: false,
      signInMail: { ready: true },
    });
    expect(await staffMayGetCode(db.query, owner.email, new Date())).toBe(false);
    const asked = await invoke("user.sendEmailConfirmation", {}, as(owner));
    expect(asked.sentTo).toBe(owner.email);
    expect(sent.map((s) => s.to)).toEqual([owner.email]);
    const code = sent[0]?.code as string;
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await invoke("user.confirmEmail", { code: wrong }, as(owner))).toMatchObject({
      confirmed: false,
    });
    expect(await invoke("user.confirmEmail", { code }, as(owner))).toMatchObject({
      confirmed: true,
    });
    expect(await verified(owner.id)).toBe(1);
    // Now sign-in by an emailed code may go to it.
    expect(await staffMayGetCode(db.query, owner.email, new Date())).toBe(true);
    expect((await auditChanges(owner.id)).map((c) => c.diff)).toContainEqual({
      emailVerified: { before: false, after: true },
    });
  });

  it("a code sent to an address the account no longer has confirms nothing", async () => {
    const user = await unverified();
    await invoke("user.sendEmailConfirmation", {}, as(user));
    const code = sent[0]?.code as string;
    const changed = `moved-${user.email}`;
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?")
      .bind(changed, user.id)
      .run();
    expect(
      await invoke("user.confirmEmail", { code }, as({ ...user, email: changed })),
    ).toMatchObject({ confirmed: false });
    expect(await verified(user.id)).toBe(0);
  });

  it("one account's code does nothing for another", async () => {
    const a = await unverified();
    const b = await unverified();
    await invoke("user.sendEmailConfirmation", {}, as(a));
    const code = sent[0]?.code as string;
    expect((await refusal(invoke("user.confirmEmail", { code }, as(b)))).code).toBe(
      "invalid_input",
    );
    expect(await verified(b.id)).toBe(0);
  });

  it("three wrong tries end the code", async () => {
    const user = await unverified();
    await invoke("user.sendEmailConfirmation", {}, as(user));
    const code = sent[0]?.code as string;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await invoke("user.confirmEmail", { code: wrong }, as(user));
    expect((await refusal(invoke("user.confirmEmail", { code }, as(user)))).code).toBe(
      "invalid_input",
    );
    expect(await verified(user.id)).toBe(0);
  });

  it("an expired code confirms nothing", async () => {
    const user = await unverified();
    await invoke("user.sendEmailConfirmation", {}, as(user));
    await env.DB.prepare("UPDATE core_email_confirmation SET expires_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), user.id)
      .run();
    expect(
      await invoke("user.confirmEmail", { code: sent[0]?.code as string }, as(user)),
    ).toMatchObject({ confirmed: false });
    expect(await verified(user.id)).toBe(0);
  });

  it("is refused, and sends nothing, while sign-in mail is not ready", async () => {
    const user = await unverified();
    mailProblem = 'an admin turns on "Send sign-in codes"';
    const refused = await refusal(invoke("user.sendEmailConfirmation", {}, as(user)));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("Send sign-in codes");
    expect(sent).toEqual([]);
    expect((await invoke("user.emailStatus", {}, as(user))).signInMail).toEqual({
      ready: false,
      problem: mailProblem,
    });
  });

  it("asks a moment between codes", async () => {
    const user = await unverified();
    await invoke("user.sendEmailConfirmation", {}, as(user));
    expect((await refusal(invoke("user.sendEmailConfirmation", {}, as(user)))).code).toBe(
      "conflict",
    );
    await age(user.id);
    await invoke("user.sendEmailConfirmation", {}, as(user));
    expect(sent).toHaveLength(2);
  });

  it("is a person's, for their own account, and not on MCP", async () => {
    for (const name of ["user.emailStatus", "user.sendEmailConfirmation", "user.confirmEmail"]) {
      const op = coreRegistry.get(name);
      expect(op?.actors, name).toEqual(["human"]);
      expect(op?.mcp?.expose, name).toBe(false);
    }
    const user = await unverified();
    for (const extra of [
      { actor: "mcp", origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: "s" } },
      { actor: "assistant", origin: { surface: "assistant", sessionId: "ath_1" } },
      { actor: "automation", origin: { surface: "automation", automationId: "aut_1" } },
    ]) {
      expect(
        (await refusal(invoke("user.sendEmailConfirmation", {}, as(user, extra as never)))).code,
      ).toBe("forbidden");
    }
    expect(sent).toEqual([]);
  });
});
