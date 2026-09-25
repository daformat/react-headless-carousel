import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { Carousel } from "../src/Carousel.js";

/**
 * A carousel whose content may or may not overflow. Drag, click the buttons,
 * select the text and drag the links in each one: a carousel with nothing to
 * scroll should behave like any other part of the page.
 */
const Demo = ({
  label,
  initialCount,
  loop = false,
}: {
  label: string;
  initialCount: number;
  loop?: boolean;
}) => {
  const [count, setCount] = useState(initialCount);
  const [clicks, setClicks] = useState(0);
  const [info, setInfo] = useState("");

  useEffect(() => {
    const id = setInterval(() => {
      const vp = document.querySelector<HTMLElement>(`#vp-${label}`);
      if (!vp) {
        return;
      }
      setInfo(
        JSON.stringify({
          scrollLeft: Math.round(vp.scrollLeft),
          maxScroll: Math.round(vp.scrollWidth - vp.clientWidth),
          overflowX: vp.style.overflowX,
          selection: document.getSelection()?.toString().slice(0, 40) ?? "",
        }),
      );
    }, 100);
    return () => clearInterval(id);
  }, [label]);

  return (
    <div className="demo">
      <h3>{label}</h3>
      <div>
        <button onClick={() => setCount((c) => Math.max(1, c - 1))}>
          - item
        </button>
        <button onClick={() => setCount((c) => c + 1)}>+ item</button>
        <span>
          {count} items, {clicks} clicks
        </span>
      </div>
      <Carousel.Root loop={loop}>
        <Carousel.Viewport
          id={`vp-${label}`}
          className="viewport"
          contentFade={false}
        >
          <Carousel.Content className="content">
            {Array.from({ length: count }, (_, i) => (
              <Carousel.Item key={i} className="item">
                <span>Selectable text {i}</span>
                <button type="button" onClick={() => setClicks((c) => c + 1)}>
                  click {i}
                </button>
                <a href={`#item-${i}`}>link {i}</a>
              </Carousel.Item>
            ))}
          </Carousel.Content>
        </Carousel.Viewport>
        <Carousel.PrevPage>prev</Carousel.PrevPage>
        <Carousel.NextPage>next</Carousel.NextPage>
      </Carousel.Root>
      <pre>{info}</pre>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <>
    <p>
      When the content fits, a mouse drag should not be taken over: text
      selects, links drag natively and each button click counts once. Add items
      until it overflows and dragging should kick back in, along with click
      suppression after a drag.
    </p>
    <Demo label="fits" initialCount={3} />
    <Demo label="overflows" initialCount={12} />
    <Demo label="fits-loop" initialCount={3} loop />
  </>,
);
