export function Message({ title, detail, tone }: { title: string; detail?: string; tone?: 'error' }) {
  return (
    <div className="bi-message" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}
