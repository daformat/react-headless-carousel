import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Carousel } from "../src/Carousel.js";

const Demo = ({
  label,
  count,
  loop,
  snap,
  width,
  autoplay,
  align = "start",
}: {
  label: string;
  count: number;
  loop: boolean;
  snap?: string;
  width?: number;
  autoplay?: boolean | Record<string, unknown>;
  align?: "start" | "center" | "end";
}) => {
  const [info, setInfo] = useState("");
  useEffect(() => {
    const id = setInterval(() => {
      const vp = document.querySelector<HTMLElement>(`#vp-${label}`);
      if (!vp) {
        return;
      }
      const content = vp.querySelector<HTMLElement>("[data-carousel-content]")!;
      setInfo(
        JSON.stringify({
          scrollLeft: Math.round(vp.scrollLeft),
          maxScroll: Math.round(vp.scrollWidth - vp.clientWidth),
          items: content.children.length,
          snap: vp.style.scrollSnapType || "(none)",
          autoplay:
            (vp.closest("[data-carousel-autoplay]") as HTMLElement | null)
              ?.dataset.carouselAutoplay ?? "off",
        }),
      );
    }, 100);
    return () => clearInterval(id);
  }, [label]);

  return (
    <div className="demo">
      <h3>{label}</h3>
      <Carousel.Root loop={loop} autoplay={autoplay as never}>
        <Carousel.Viewport
          id={`vp-${label}`}
          className="viewport"
          scrollSnapType={snap}
          contentFade={false}
        >
          <Carousel.Content className="content">
            {Array.from({ length: count }, (_, i) => (
              <Carousel.Item
                key={i}
                className="item"
                style={{
                  scrollSnapAlign: snap ? align : undefined,
                  width: width ?? 160,
                }}
              >
                {i}
              </Carousel.Item>
            ))}
          </Carousel.Content>
        </Carousel.Viewport>
        <Carousel.PrevPage>prev</Carousel.PrevPage>
        <Carousel.NextPage>next</Carousel.NextPage>
      </Carousel.Root>
      <pre id={`info-${label}`}>{info}</pre>
    </div>
  );
};

const Toggle = () => {
  const [loop, setLoop] = useState(true);
  return (
    <div>
      <button id="toggle-loop" onClick={() => setLoop((v) => !v)}>
        loop: {String(loop)}
      </button>
      <Demo label="toggle" count={6} loop={loop} snap="x mandatory" />
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <>
    <Toggle />
    <Demo label="loop-snap" count={6} loop snap="x mandatory" />
    <Demo label="loop-nosnap" count={6} loop />
    <Demo label="loop-few" count={2} loop snap="x mandatory" />
    <Demo label="no-loop" count={6} loop={false} snap="x mandatory" />
    <Demo
      label="auto-continuous"
      count={6}
      loop
      autoplay={{ mode: "continuous", speed: 90 }}
    />
    <Demo
      label="auto-item"
      count={6}
      loop
      snap="x mandatory"
      autoplay={{ mode: "item", interval: 1200 }}
    />
    <Demo
      label="auto-page"
      count={6}
      loop
      snap="x mandatory"
      autoplay={{ mode: "page", interval: 1500 }}
    />
    <Demo
      label="auto-rewind"
      count={6}
      loop={false}
      snap="x mandatory"
      autoplay={{ mode: "item", interval: 700, atEnd: "rewind" }}
    />
    <Demo
      label="auto-reverse"
      count={6}
      loop={false}
      autoplay={{
        mode: "continuous",
        speed: 200,
        atEnd: "reverse",
        pauseAtEnd: 1500,
      }}
    />
    <Demo
      label="auto-center"
      count={6}
      loop={false}
      snap="x mandatory"
      align="center"
      autoplay={{ mode: "item", interval: 900 }}
    />
    <Demo
      label="auto-end"
      count={6}
      loop={false}
      snap="x mandatory"
      align="end"
      autoplay={{ mode: "item", interval: 900 }}
    />
    <Demo
      label="auto-stop"
      count={6}
      loop={false}
      snap="x mandatory"
      autoplay={{ mode: "item", interval: 500, atEnd: "stop" }}
    />
  </>,
);
