import type { Metadata } from "next";
import { WatchPlayer } from "./watch-player";
import "./watch.css";

export const metadata: Metadata = { title: "Watch · Cutroom", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function Watch({ params }: { params: Promise<{ token: string }> }) {
  return <WatchPlayer token={(await params).token} />;
}
