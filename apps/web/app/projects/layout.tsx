import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SignOut } from "./sign-out";
import { Brand } from "../brand";

export const metadata: Metadata = { title: "My projects · Cutroom", robots: { index: false } };

export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return <>
    <header className="topbar">
      <Brand href="/projects" />
      <span className="divider" aria-hidden="true">/</span><a className="workspace" href="/projects">My projects</a>
      <SignOut />
    </header>
    {children}
  </>;
}
