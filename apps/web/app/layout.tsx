import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Earthrise · Cutroom",
  description: "A private video editing studio with frame-accurate cuts, live preview, and MP4 export.",
  icons: { icon: "/media/opening.jpg" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
