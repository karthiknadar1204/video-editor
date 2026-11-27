"use client";

import { useState } from "react";
import { authClient } from "../account/client";

export function SignOut() {
  const [failed, setFailed] = useState(false);
  async function signOut() {
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error();
      window.location.replace("/account");
    } catch { setFailed(true); }
  }
  return <div className="export">
    {failed && <span role="alert">Could not sign out. Try again.</span>}
    <button className="quiet" onClick={signOut}>Sign out</button>
  </div>;
}
