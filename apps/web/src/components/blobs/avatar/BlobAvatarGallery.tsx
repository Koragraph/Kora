/**
 * Design-review gallery: every accessory, state, size, reaction and the 11 starter blobs.
 * Self-contained (own CSS, no props); mount it on a dev route.
 */
import { useRef, useState } from "react";

import "./blobPicker.css";
import {
  BLOB_SIZES,
  BLOB_STATES,
  BlobAvatar,
  type BlobAvatarHandle,
  BLOB_REACTIONS,
} from "./BlobAvatar";
import { OutfitPicker } from "./OutfitPicker";
import {
  ACCESSORY_CHOICES,
  ACCESSORY_LABELS,
  type BlobOutfit,
  STARTER_BLOB_IDS,
  STARTER_NAMES,
  STARTER_OUTFITS,
} from "./outfit";

const SAMPLE: BlobOutfit = { face: "round-glasses" };
const outfitOf = (c: (typeof ACCESSORY_CHOICES)[number]): BlobOutfit =>
  c.slot === "head" ? { head: c.id } : { face: c.id };

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="blob-gallery__cell">
      {children}
      <span>{label}</span>
    </div>
  );
}

export function BlobAvatarGallery() {
  const [outfit, setOutfit] = useState<BlobOutfit>({ head: "top-hat" });
  const handles = useRef<Record<string, BlobAvatarHandle | null>>({});

  return (
    <div className="blob-gallery" data-testid="blob-avatar-gallery">
      <section>
        <h2>Starter roster</h2>
        <div className="blob-gallery__grid">
          {STARTER_BLOB_IDS.map((id) => (
            <Cell key={id} label={id === "kora" ? "Kora · Chief" : STARTER_NAMES[id]}>
              <BlobAvatar
                size={56}
                chief={id === "kora"}
                badge={id === "kora"}
                outfit={STARTER_OUTFITS[id]}
                seed={id}
              />
            </Cell>
          ))}
        </div>
      </section>

      <section>
        <h2>Accessories (one per blob)</h2>
        <div className="blob-gallery__grid">
          {ACCESSORY_CHOICES.map((c) => (
            <Cell key={c.id} label={ACCESSORY_LABELS[c.id]}>
              <BlobAvatar size={56} outfit={outfitOf(c)} seed={c.id} />
            </Cell>
          ))}
          <Cell label="None">
            <BlobAvatar size={56} outfit={{}} seed="none" />
          </Cell>
        </div>
      </section>

      <section>
        <h2>States</h2>
        <div className="blob-gallery__grid">
          {BLOB_STATES.map((state) => (
            <Cell key={state} label={state}>
              <BlobAvatar size={56} state={state} outfit={SAMPLE} seed={state} />
            </Cell>
          ))}
        </div>
      </section>

      <section>
        <h2>Reactions (click)</h2>
        <div className="blob-gallery__grid">
          {BLOB_REACTIONS.map((reaction) => (
            <Cell key={reaction} label={reaction}>
              <button
                type="button"
                className="blob-gallery__btn"
                onClick={() => handles.current[reaction]?.play(reaction)}
              >
                <BlobAvatar
                  ref={(h) => {
                    handles.current[reaction] = h;
                  }}
                  size={56}
                  outfit={SAMPLE}
                  seed={reaction}
                />
              </button>
            </Cell>
          ))}
        </div>
      </section>

      <section>
        <h2>Sizes</h2>
        <div className="blob-gallery__sizes">
          {BLOB_SIZES.map((size) => (
            <div key={size} className="blob-gallery__size">
              <BlobAvatar size={size} outfit={SAMPLE} seed={size} />
              <span>{size}</span>
            </div>
          ))}
        </div>
        <div className="blob-gallery__sizes" style={{ marginTop: 10 }}>
          {BLOB_SIZES.map((size) => (
            <div key={size} className="blob-gallery__size">
              <BlobAvatar size={size} chief badge outfit={STARTER_OUTFITS.kora} seed={size} />
              <span>chief {size}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Small sizes, every accessory</h2>
        <div className="blob-gallery__sizes">
          {ACCESSORY_CHOICES.map((c, i) => (
            <BlobAvatar key={c.id} size={i % 2 === 0 ? 20 : 24} outfit={outfitOf(c)} seed={i} />
          ))}
        </div>
      </section>

      <section>
        <h2>Outfit picker</h2>
        <OutfitPicker value={outfit} onChange={setOutfit} />
      </section>
    </div>
  );
}
