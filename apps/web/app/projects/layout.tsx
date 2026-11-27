import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SignOut } from "./sign-out";

export const metadata: Metadata = { title: "My projects · Cutroom", robots: { index: false } };

export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return <>
    <header className="topbar">
      <a className="brand" href="/projects"><span className="mark" aria-hidden="true">◩</span>Cutroom</a>
      <span className="divider" aria-hidden="true">/</span><a className="workspace" href="/projects">My projects</a>
      <SignOut />
    </header>
    {children}
  </>;
}
