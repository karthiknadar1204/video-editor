import type { Metadata } from "next";
import { AccountForm } from "./form";
import { Brand } from "../brand";

export const metadata: Metadata = { title: "Account · Cutroom", referrer: "no-referrer" };

export default async function Account({ searchParams }: {
  searchParams: Promise<{ view?: string; token?: string; error?: string }>;
}) {
  const { view, token, error } = await searchParams;
  const mode = view === "signup" || view === "forgot" || view === "reset" ? view : "signin";
  return <>
    <header className="topbar"><Brand /><a className="workspace nav-end" href="/">Sample film <span aria-hidden="true">↗</span></a></header>
    <main className="account-layout">
      <AccountForm key={mode} mode={mode} token={token} invalidLink={Boolean(error)} />
      <figure className="sample-card">
        <img src="/media/earthrise-cover.jpg" alt="Earth rising above the lunar horizon" />
        <figcaption><div><small>Apollo 8 <span>/</span> 1968</small><strong>Earthrise</strong></div><a href="/" aria-label="Open Earthrise sample film"><span aria-hidden="true">▶</span></a></figcaption>
      </figure>
    </main>
  </>;
}
