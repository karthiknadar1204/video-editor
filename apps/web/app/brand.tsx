export function Brand({ href = "/" }: { href?: string }) {
  return <a className="brand" href={href}><span className="brand-symbol" aria-hidden="true" />Cutroom</a>;
}
