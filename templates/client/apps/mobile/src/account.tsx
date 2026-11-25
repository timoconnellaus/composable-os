// The Account tab (stage 48): My account's native shell (`native-account`), with "Needs your
// attention" at the top and then the customer's sections, each the host's answer. `cos create
// --with-mobile` copies the shell and its sections into src/blocks/ (they are yours: restyle them,
// `cos diff native-account` shows what changes upstream) and writes src/blocks/
// account-sections.gen.ts, which names the sections of the packs product.ts lists: after adding a
// pack, run `cos add native-account` again. This file names no pack.
//
// Money in the app is the website's (ADR 0714): the card, cancelling, changing plan and paying an
// order open the business's website account page (`websiteUrl`). Changing the sign-in address and
// deleting the account work here; when the host asks for a recent sign-in they sign in again in
// place with the app's own sign-in by code, which ends the session it replaces on the host.
// Deleting the account ends this device's session at once (`endSession`), then `onSignedOut`.
import {
  type AccountSignIn,
  createAccountHooks,
  createAgreementsHooks,
} from "@composable-os/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ACCOUNT_SECTIONS } from "./blocks/account-sections.gen.ts";
import { AccountScreen, usePackSections } from "./blocks/native-account/account-screen.tsx";
import type { HostSession } from "./host.ts";

/** The React functions the packs' hooks are made with: at module level, so they are made once. */
const react = { useQuery, useMutation, useState, useEffect };

export function AccountTab({
  session,
  websiteUrl,
  onSignedOut,
  openUrl,
}: {
  session: Pick<HostSession, "api" | "requestCode" | "signIn" | "signOut">;
  /** The business's website account page (`extra.websiteUrl`, from product.ts by app.config.ts). */
  websiteUrl: string;
  /** This device is signed out (or the account deleted): back to sign-in. */
  onSignedOut: () => void;
  /** Opens an address in the browser; React Native's `Linking.openURL` by default. */
  openUrl?: (url: string) => void;
}) {
  const api = session.api;
  // `useQueryClient` lets a deletion forget the cache at once.
  const account = useMemo(
    () => createAccountHooks({ useQuery, useMutation, useQueryClient }, api),
    [api],
  );
  const agreements = useMemo(() => createAgreementsHooks({ useQuery, useMutation }, api), [api]);
  const sections = usePackSections(ACCOUNT_SECTIONS, react, api);
  const signIn = useMemo<AccountSignIn>(
    () => ({
      requestCode: (email) => session.requestCode(email),
      confirm: (email, code) => session.signIn(email, code),
    }),
    [session],
  );
  return (
    <AccountScreen
      account={account}
      agreements={agreements}
      sections={sections}
      websiteUrl={websiteUrl}
      signIn={signIn}
      endSession={() => session.signOut()}
      onSignOut={() => void session.signOut().then(onSignedOut, onSignedOut)}
      onDeleted={onSignedOut}
      {...(openUrl ? { openUrl } : {})}
    />
  );
}
