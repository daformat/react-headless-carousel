import { Fragment, type ReactNode, useState } from "react";

type Direction = "ltr" | "rtl";

const readDirection = (): Direction =>
  new URLSearchParams(window.location.search).get("dir") === "rtl"
    ? "rtl"
    : "ltr";

/**
 * Lays the demos out in the direction given by `?dir=rtl`, with buttons to
 * switch. The direction sits on a wrapper rather than on the document, so the
 * toolbar stays put while the carousels flip.
 *
 * Switching remounts the demos, so they start out in the new direction the way
 * a page loaded in it would. Flipping live keeps them mounted instead, which is
 * what a page changing `dir` at runtime looks like to the carousel.
 */
export const DirectionControls = ({ children }: { children: ReactNode }) => {
  const [dir, setDir] = useState(readDirection);
  const [mountedAs, setMountedAs] = useState(dir);
  const flip = ({ remount }: { remount: boolean }) => {
    const next = dir === "rtl" ? "ltr" : "rtl";
    const url = new URL(window.location.href);
    url.searchParams.set("dir", next);
    window.history.replaceState(null, "", url);
    setDir(next);
    if (remount) {
      setMountedAs(next);
    }
  };
  return (
    <>
      <div className="toolbar">
        <button id="toggle-dir" onClick={() => flip({ remount: true })}>
          dir: {dir}
        </button>
        <button id="flip-dir-live" onClick={() => flip({ remount: false })}>
          flip dir live
        </button>
        {dir !== mountedAs ? (
          <span>mounted as {mountedAs}, flipped live</span>
        ) : null}
      </div>
      <div dir={dir}>
        <Fragment key={mountedAs}>{children}</Fragment>
      </div>
    </>
  );
};

/**
 * What the info line under each demo shows about the scroll: `scrollLeft` as
 * the browser reports it (negative towards the end in RTL) and `offset`, the
 * distance from the inline start the carousel works with.
 */
export const describeScroll = (viewport: HTMLElement) => {
  const dir = getComputedStyle(viewport).direction;
  return {
    dir,
    scrollLeft: Math.round(viewport.scrollLeft),
    offset: Math.round(
      dir === "rtl" ? Math.abs(viewport.scrollLeft) : viewport.scrollLeft,
    ),
    maxScroll: Math.round(viewport.scrollWidth - viewport.clientWidth),
  };
};
