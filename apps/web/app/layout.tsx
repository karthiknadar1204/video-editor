import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Earthrise · Cutroom",
  description: "Preview and export the Earthrise sequence.",
  icons: { icon: "/media/opening.jpg" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
