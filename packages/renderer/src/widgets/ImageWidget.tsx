import type { ImageWidget as ImageSpec } from '@yourorg/bi-spec';
import { Message } from './Message';
import type { WidgetProps } from './types';

/** Only https URLs are ever rendered, whatever reached the renderer (defense in depth over validation). */
export function safeHttpsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Static image (logo, diagram). No query. Never sends a referrer; links open in a new tab. */
export function ImageWidget({ widget }: WidgetProps<ImageSpec>) {
  const { alt, fit, caption } = widget.options;
  const src = safeHttpsUrl(widget.options.src);
  const href = safeHttpsUrl(widget.options.href);
  if (!src) return <Message title="Image not shown" detail="Only https:// images can be displayed." />;
  const img = <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" decoding="async" data-fit={fit} />;
  return (
    <figure className="bi-image">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {img}
        </a>
      ) : (
        img
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
