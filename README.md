# React headless carousel

![NPM Version](https://img.shields.io/npm/v/%40daformat%2Freact-headless-carousel)
![gzipped](https://img.shields.io/bundlephobia/minzip/@daformat/react-headless-carousel?color=%238ab4f8&label=gzip)
![NPM Downloads](https://img.shields.io/npm/dm/%40daformat%2Freact-headless-carousel)  
[![Follow daformat on GitHub](https://img.shields.io/github/followers/daformat?label=Follow%20%40daformat&style=social)](https://github.com/daformat)
[![Follow daformat on X](https://img.shields.io/twitter/follow/daformat?label=Follow%20%40daformat&style=social)](https://twitter.com/daformat)

A react headless carousel component with zero-dependency: scrollable, and swipeable carousel, even on desktop, complete
with snapping,
friction, rubber-banding and overscroll.

## Installation

```bash
npm install @daformat/react-headless-carousel
```

```bash
yarn add @daformat/react-headless-carousel
```

```bash
pnpm add @daformat/react-headless-carousel

```

```bash
bun add @daformat/react-headless-carousel
```

```bash
deno add npm:@daformat/react-headless-carousel
```

## Demo

https://hello-mat.com/design-engineering/component/carousel-component

## Component structure

```tsx
/* Provides context to the carousel components */
<Carousel.Root>
  {/* The scrollable area */}
  <Carousel.Viewport>
    {/* The container for the items */}
    <Carousel.Content>
      {/* A carousel item */}
      <Carousel.Item />
      <Carousel.Item />
      <Carousel.Item />
    </Carousel.Content>
  </Carousel.Viewport>
  {/* The pagination buttons */}
  <Carousel.PrevPage />
  <Carousel.NextPage />
</Carousel.Root>
```

## Components

### `Carousel.Root`

The outermost wrapper. Provides context to all child carousel components. Renders a `<div>`.

| Prop             | Type                                                                            | Default                 | Description                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loop`           | `boolean`                                                                       | `false`                 | Renders copies of the children on either side and wraps the scroll position, so the carousel never reaches an end. See [Looping](#looping).                                                                                                                                                                                                              |
| `autoplay`       | `boolean \| AutoplayOptions`                                                    | `false`                 | Scrolls the carousel on its own. `true` steps to the next item every three seconds; pass an object to choose how and how fast. See [Autoplay](#autoplay).                                                                                                                                                                                                |
| `boundaryOffset` | `{ x: number; y: number } \| ((root: HTMLElement) => { x: number; y: number })` | `defaultBoundaryOffset` | Inset in pixels from the leading and trailing edges of the viewport used when scrolling items into view with prev/next buttons. The default implementation reads the content fade size from the viewport so items are never scrolled behind the fade. Pass a plain object or a function receiving the root element and returning `{ x, y }` to override. |
| `ref`            | `Ref<HTMLDivElement>`                                                           | n/a                     | Forwarded ref to the root `<div>`.                                                                                                                                                                                                                                                                                                                       |
| `...props`       | `ComponentPropsWithoutRef<"div">`                                               | n/a                     | All standard `<div>` props (`className`, `style`, `children`, etc.).                                                                                                                                                                                                                                                                                     |

#### Looping

`loop` is off by default. Turning it on makes the carousel endless in both directions: it renders the children three
times over, plus however many extra copies it takes for one of those sets to cover a few viewports, then teleports the
scroll position back by a whole number of copies whenever it comes close to running out. The position it leaves and the
one it lands on show the same pixels, so the jump itself is not visible.

On mount the carousel parks on the first of your actual children, instantly and without a visible scroll. The copies are
marked `data-loop-clone`, `aria-hidden` and `tabindex="-1"`, so the copied elements themselves are passed over by
assistive technology and by tabbing, and when the scroll settles the carousel comes home to your real children.

That covers each copy, not what is inside it: a copy holding a link or a button still has that control in the tab
order, since neither attribute reaches a descendant. Items that hold something focusable will therefore tab through
the copies too, and a copy on screen stays clickable. That is usually what you want from something the user can plainly
see, but it does mean tabbing can land inside an `aria-hidden` copy, in DOM order, which is not the order the copies
come round on screen. Three things keep that from being visible:

- **Tabbing in lands on what is already on screen.** The first thing in the tab order sits inside the very first copy,
  right at the start of the content, so going to fetch it sweeps the carousel back to the beginning. The arriving
  focus is handed to the first fully visible element instead, and the scroll stays where it was. Shift-tabbing in
  takes the last visible one.
- **Tabbing on never doubles back.** When the next element in the tab order sits a long way behind the current
  position, the carousel first jumps whole copies towards it. Either side of such a jump shows the same pixels, so
  none of that distance is seen, and the remainder is short enough to animate the way the tabbing is already going
  rather than against it. When the scroll cannot go that way, because there is no more content on that side, the focus
  goes to the copy of that element already within reach, and nothing moves at all.
- **The focus ring goes where the focus went.** A jump carries whatever was focused inside a copy off screen with it.
  The focus is handed to the element that took its place, so the ring stays where the user is looking instead of
  appearing to vanish a moment after tabbing.

All three are for the keyboard only. A click focuses whatever was clicked, copy or not, and gets the ordinary
scroll-the-minimum-needed treatment.

> **Looping and snapping are a best-effort pairing.** Every browser drives a wheel scroll towards a snap point it
> chooses when the gesture starts, and none of them take kindly to the scroll position moving underneath: Chromium
> scrolls back to the item it had picked, Safari swallows the rest of the momentum, Firefox drops the snap it was about
> to apply. So when a wrap disturbs a scroll, the carousel takes snapping off the browser for the rest of that gesture
> and applies it itself once everything stops, animating to the position your `scroll-snap-type` asks for. Chromium
> commits to its target early enough that the whole gesture has to run that way. Dragging is unaffected, since it has
> always managed its own snapping and lands on a snap point by itself.
>
> The upshot: snapping is honoured every time the carousel comes to rest, but exactly _how_ it gets there varies by
> engine, and a very long fling may still show a seam. If you need snapping to be exact under all circumstances, leave
> `loop` off.

#### Autoplay

`autoplay` scrolls the carousel on its own. Pass `true` for the defaults, or an object to configure it.

```tsx
<Carousel.Root autoplay />
<Carousel.Root autoplay={{ mode: "continuous", speed: 90 }} />
<Carousel.Root autoplay={{ mode: "page", interval: 5000 }} />
<Carousel.Root autoplay={{ mode: "continuous", atEnd: "reverse", pauseAtEnd: 1500 }} />
<Carousel.Root autoplay={{ mode: "item", pauseOnInteraction: 5000 }} />
```

Hovering and focusing describe a mouse and a keyboard. A touch has neither, so `pauseOnInteraction` is what stops the
carousel taking an item away from someone reading it on a phone: scrolling or dragging holds it, and it picks up again
once they have left it alone: a drag for as long as the finger is down, a scroll for as long as it keeps going.

| Option               | Type                               | Default      | Description                                                                                                                                           |
| -------------------- | ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`               | `"item" \| "page" \| "continuous"` | `"item"`     | `item` steps to the next item, `page` makes the same move as the prev/next buttons, `continuous` scrolls at a steady speed without stopping on items. |
| `direction`          | `"forwards" \| "backwards"`        | `"forwards"` | Which way to go.                                                                                                                                      |
| `interval`           | `number`                           | `3000`       | Milliseconds between steps. `item` and `page` only.                                                                                                   |
| `speed`              | `number`                           | `60`         | Pixels per second. `continuous` only.                                                                                                                 |
| `atEnd`              | `"rewind" \| "reverse" \| "stop"`  | `"rewind"`   | What to do on running out of content: go back to the end it started from, turn around and play back, or stop. Not available with a literal `loop`.    |
| `pauseAtEnd`         | `number`                           | `0`          | Milliseconds to sit still at each end before `atEnd` takes over. `continuous` only, and not with a literal `loop`.                                    |
| `pauseOnHover`       | `boolean`                          | `true`       | Pause while the pointer is over the carousel.                                                                                                         |
| `pauseOnFocus`       | `boolean`                          | `true`       | Pause while the focus is anywhere inside the carousel, items included.                                                                                |
| `pauseOnInteraction` | `number \| false`                  | `1500`       | Milliseconds to wait after the user has scrolled or dragged before picking up again. `false` carries on regardless.                                   |

The options that do not apply to a given configuration are compile errors rather than settings that quietly do nothing,
and the type carries the reason: hovering `atEnd` on a looping carousel says it does not apply there, since a looping
carousel never runs out of content. Mixing up `speed` and `interval` puts that explanation in the error itself.

Beyond `pauseOnHover` and `pauseOnFocus`, autoplay also gets out of the way on its own while you are dragging, while a
wheel gesture's momentum is still running, and while the tab is hidden. It does not run at all when the user asks for
`prefers-reduced-motion: reduce`, and it picks that change up live.

#### Data attributes set on the root

| Attribute                | Values                    | Description                                                                                                |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data-carousel-autoplay` | `"playing"` \| `"paused"` | Present only while `autoplay` is on, so it doubles as a way to style or assert the current autoplay state. |

---

### `Carousel.Viewport`

The scrollable container. Handles pointer/mouse dragging, momentum, rubber-banding, scroll-snapping, and keyboard focus
scrolling. Renders a `<div>` with `overflow: scroll` and hidden scrollbars.

| Prop              | Type                              | Default                     | Description                                                                                                                                                                     |
| ----------------- | --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrollSnapType`  | `CSSProperties["scrollSnapType"]` | n/a                         | CSS `scroll-snap-type` value applied to the container (e.g. `"x mandatory"`). Snapping is coordinated with the momentum animation so the carousel always lands on a snap point. |
| `contentFade`     | `boolean`                         | `true`                      | When `true`, a mask-image fade is applied to both edges of the viewport. The fade appears only when there is scrollable content in that direction.                              |
| `contentFadeSize` | `string \| number`                | `"clamp(16px, 10vw, 64px)"` | Width of the content fade. Accepts any CSS length string or a `number` (interpreted as `px`). Only valid when `contentFade` is `true` (or omitted).                             |
| `ref`             | `Ref<HTMLDivElement>`             | n/a                         | Forwarded ref to the viewport `<div>`.                                                                                                                                          |
| `...props`        | `ComponentPropsWithoutRef<"div">` | n/a                         | All standard `<div>` props. Event handlers `onPointerDown`, `onPointerMove`, `onPointerUp`, `onClickCapture`, and `onWheel` are merged with the internal handlers.              |

#### Data attributes set on the viewport

| Attribute                | Values                                                | Description                                                                                                |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data-carousel-viewport` | `""`                                                  | Always present. Used internally for boundary offset calculation.                                           |
| `data-can-scroll`        | `"forwards"` \| `"backwards"` \| `"both"` \| `"none"` | Reflects the current scrollability. Useful for styling buttons or indicators with CSS attribute selectors. |

---

### `Carousel.Content`

A thin wrapper that sets `width: fit-content` so items lay out in a single row. Renders a `<div>`.

| Prop       | Type                              | Default | Description                                                              |
| ---------- | --------------------------------- | ------- | ------------------------------------------------------------------------ |
| `ref`      | `Ref<HTMLDivElement>`             | n/a     | Forwarded ref to the content `<div>`.                                    |
| `...props` | `ComponentPropsWithoutRef<"div">` | n/a     | All standard `<div>` props. Styles are merged with `width: fit-content`. |

---

### `Carousel.Item`

A single carousel slide. By default renders a `<div>` with `will-change: transform` (required for the rubber-banding
animation). Use `asChild` to merge onto your own element.

| Prop       | Type                              | Default | Description                                                                                                                                                                                                          |
| ---------- | --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asChild`  | `boolean`                         | `false` | When `true`, merges all props (including `data-carousel-item` and `style`) onto the single child element via `cloneElement` instead of rendering a wrapping `<div>`. The child must be a single valid React element. |
| `ref`      | `Ref<HTMLElement>`                | n/a     | Forwarded ref. When `asChild` is `true`, forwarded to the child element.                                                                                                                                             |
| `...props` | `ComponentPropsWithoutRef<"div">` | n/a     | All standard `<div>` props. `style` is merged with `will-change: transform`.                                                                                                                                         |

---

### `Carousel.NextPage`

A button that scrolls the carousel forwards by one page or to the next partially-visible item. Automatically disabled
when there is no more content to scroll forwards. Renders a `<button>`.

| Prop       | Type                                   | Default            | Description                                                                                                           |
| ---------- | -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `disabled` | `boolean`                              | `!scrollsForwards` | Overrides the automatic disabled state. Pass `false` to always keep the button enabled regardless of scroll position. |
| `onClick`  | `MouseEventHandler<HTMLButtonElement>` | n/a                | Called after the scroll action is triggered.                                                                          |
| `ref`      | `Ref<HTMLButtonElement>`               | n/a                | Forwarded ref to the `<button>`.                                                                                      |
| `...props` | `ComponentPropsWithoutRef<"button">`   | n/a                | All standard `<button>` props.                                                                                        |

---

### `Carousel.PrevPage`

A button that scrolls the carousel backwards by one page or to the previous partially-visible item. Automatically
disabled when the carousel is at the start. Renders a `<button>`.

| Prop       | Type                                   | Default             | Description                                  |
| ---------- | -------------------------------------- | ------------------- | -------------------------------------------- |
| `disabled` | `boolean`                              | `!scrollsBackwards` | Overrides the automatic disabled state.      |
| `onClick`  | `MouseEventHandler<HTMLButtonElement>` | n/a                 | Called after the scroll action is triggered. |
| `ref`      | `Ref<HTMLButtonElement>`               | n/a                 | Forwarded ref to the `<button>`.             |
| `...props` | `ComponentPropsWithoutRef<"button">`   | n/a                 | All standard `<button>` props.               |

---

## `Carousel.useCarouselContext`

A hook that provides access to the carousel's internal state and actions. Must be used inside `Carousel.Root`.

```tsx
const {
  scrollsForwards,
  scrollsBackwards,
  handleScrollToNext,
  handleScrollToPrev,
  scrollIntoView,
  remainingForwards,
  remainingBackwards,
  clearAnimation,
} = Carousel.useCarouselContext();
```

| Property                                       | Type                                                                                                       | Description                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrollsForwards`                              | `boolean`                                                                                                  | `true` when the carousel has scrollable content ahead.                                                                                                                                                              |
| `scrollsBackwards`                             | `boolean`                                                                                                  | `true` when the carousel has scrollable content behind.                                                                                                                                                             |
| `remainingForwards`                            | `React.RefObject<number>`                                                                                  | Ref containing the number of pixels remaining to scroll forwards. Updated on every scroll event.                                                                                                                    |
| `remainingBackwards`                           | `React.RefObject<number>`                                                                                  | Ref containing the number of pixels remaining to scroll backwards.                                                                                                                                                  |
| `handleScrollToNext()`                         | `() => void`                                                                                               | Programmatically scroll to the next item/page, same as clicking `Carousel.NextPage`.                                                                                                                                |
| `handleScrollToPrev()`                         | `() => void`                                                                                               | Programmatically scroll to the previous item/page, same as clicking `Carousel.PrevPage`.                                                                                                                            |
| `scrollIntoView(target, container, direction)` | `(target: HTMLElement, container: HTMLElement, direction: "forwards" \| "backwards" \| "nearest") => void` | Scrolls `target` into view within `container`. `"nearest"` scrolls the minimum amount needed; `"forwards"` / `"backwards"` aligns the item to the leading or trailing edge, respecting `scroll-snap-align: center`. |
| `clearAnimation()`                             | `() => void`                                                                                               | Cancels any in-progress momentum animation.                                                                                                                                                                         |

---

## CSS custom properties

The following CSS custom properties are set on the root element and can be used for custom styling.

| Property                           | Description                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `--carousel-fade-size`             | Current fade size as resolved from `contentFadeSize`.                              |
| `--carousel-remaining-forwards`    | Pixels remaining to scroll forwards (e.g. `312px`). Updated on every scroll event. |
| `--carousel-remaining-backwards`   | Pixels remaining to scroll backwards.                                              |
| `--carousel-fade-offset-forwards`  | Fade offset at the forwards edge (used internally by the mask gradient).           |
| `--carousel-fade-offset-backwards` | Fade offset at the backwards edge.                                                 |
| `--carousel-scroll-margin-inline`  | The inline scroll margin for the carousel items                                    |

---

## Utilities

### `Carousel.defaultBoundaryOffset`

The default `boundaryOffset` function used by `Carousel.Root`. Reads `--carousel-fade-size` from the viewport element
and returns `{ x: fadeSize, y: 0 }` so that next/prev navigation never scrolls items behind the content fade. Exported
for use when composing a custom `boundaryOffset` on top of the default behaviour.

```ts
type DefaultBoundaryOffset = (root: HTMLElement) => { x: number; y: number };
```

### `Carousel.CSS_VARS`

A frozen object containing the names of all CSS custom properties used internally, useful for reading or setting them
without hardcoding strings.

```ts
Carousel.CSS_VARS.fadeSize; // "--carousel-fade-size"
Carousel.CSS_VARS.remainingForwards; // "--carousel-remaining-forwards"
Carousel.CSS_VARS.remainingBackwards; // "--carousel-remaining-backwards"
Carousel.CSS_VARS.fadeOffsetForwards; // "--carousel-fade-offset-forwards"
Carousel.CSS_VARS.fadeOffsetBackwards; // "--carousel-fade-offset-backwards"
Carousel.CSS_VARS.overscrollTranslateX; // "--carousel-overscroll-translate-x"
Carousel.CSS_VARS.scrollMarginInline; // "--carousel-scroll-margin-inline"
```

---

## Types

Every public type is exported twice, under the same definition, so pick whichever reads better where you are. Flat named
exports:

```ts
import type {
  CarouselAutoplayOptions,
  CarouselRootProps,
} from "@daformat/react-headless-carousel";
```

Or grouped on the `Carousel` object, next to the components they belong to:

```tsx
import { Carousel } from "@daformat/react-headless-carousel";

const [mode, setMode] = useState<Carousel.AutoplayMode>("item");
```

| Flat name                         | On `Carousel`                      | Description                                                                                                          |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CarouselRootProps<Loop>`         | `Carousel.RootProps<Loop>`         | Props of `Carousel.Root`. `Loop` follows the `loop` prop and decides which autoplay options come with it, see below. |
| `CarouselViewportProps`           | `Carousel.ViewportProps`           | Props of `Carousel.Viewport`.                                                                                        |
| `CarouselContentProps`            | `Carousel.ContentProps`            | Props of `Carousel.Content`.                                                                                         |
| `CarouselItemProps`               | `Carousel.ItemProps`               | Props of `Carousel.Item`.                                                                                            |
| `CarouselNextPageProps`           | `Carousel.NextPageProps`           | Props of `Carousel.NextPage`.                                                                                        |
| `CarouselPrevPageProps`           | `Carousel.PrevPageProps`           | Props of `Carousel.PrevPage`.                                                                                        |
| `CarouselAutoplayOptions<CanEnd>` | `Carousel.AutoplayOptions<CanEnd>` | The object form of the `autoplay` prop. See the note on `CanEnd` below.                                              |
| `CarouselAutoplayMode`            | `Carousel.AutoplayMode`            | `"continuous" \| "item" \| "page"`.                                                                                  |
| `CarouselAutoplayStepMode`        | `Carousel.AutoplayStepMode`        | Just the stepping modes, `"item" \| "page"`, the ones that take an `interval`.                                       |
| `CarouselAutoplayDirection`       | `Carousel.AutoplayDirection`       | `"forwards" \| "backwards"`.                                                                                         |
| `CarouselAutoplayAtEnd`           | `Carousel.AutoplayAtEnd`           | `"rewind" \| "reverse" \| "stop"`.                                                                                   |
| `CarouselBoundaryOffset`          | `Carousel.BoundaryOffset`          | The `boundaryOffset` prop: a point, or a function returning one.                                                     |
| `CarouselContext`                 | `Carousel.Context`                 | The value returned by `Carousel.useCarouselContext`.                                                                 |

Both `RootProps` and `AutoplayOptions` take a boolean type parameter about looping, and the two default in opposite
directions on purpose, which is worth knowing before you name either type yourself:

| Written as                      | Parameter is | Which autoplay options                            |
| ------------------------------- | ------------ | ------------------------------------------------- |
| `<Carousel.Root>` with no props | `false`      | the full set, since the carousel can reach an end |
| `CarouselRootProps`             | `boolean`    | both shapes, for a `loop` only known at runtime   |
| `CarouselAutoplayOptions`       | `false`      | no end options, for a carousel that loops         |

So `Carousel.Root` on its own gives you `atEnd`, while a bare `CarouselRootProps` describes a carousel that may or may
not loop, and a bare `CarouselAutoplayOptions` is the narrowest of the three.

### `AutoplayOptions` and the `CanEnd` parameter

`AutoplayOptions` takes a boolean type parameter saying whether the carousel is one that can run out of content. A
looping carousel never reaches an end, so `atEnd` and `pauseAtEnd` are only part of the type when `CanEnd` is `true`.
Writing the prop inline needs none of this, since `Carousel.Root` picks the right one from `loop`. It only matters when you
declare the options separately:

```ts
// the bare form is the narrow one: no end options, for a carousel that loops
const looping: CarouselAutoplayOptions = { mode: "item", interval: 2000 };

// a carousel that does not loop can reach an end, so pass true to get at them
const finite: CarouselAutoplayOptions<true> = {
  mode: "continuous",
  speed: 60,
  pauseAtEnd: 1000,
  atEnd: "reverse",
};
```

Note that `CanEnd` defaults to `false` while `loop` defaults to `false` too, so a variable typed as a bare
`CarouselAutoplayOptions` is the wrong shape for a default (non-looping) carousel, and will reject the `atEnd` it is
entitled to. The default is deliberately the restrictive one; reach for `<true>` whenever `loop` is off.

When `loop` is only known at runtime, pass `boolean` and get both shapes at once. This is what a wrapper component
wants: it can take a `loop` prop and hand it to `Carousel.Root` alongside the autoplay options, without having to
split into a looping and a non-looping branch or reach for a cast:

```tsx
const Gallery = ({
  loop,
  autoplay,
}: {
  loop: boolean;
  autoplay?: boolean | CarouselAutoplayOptions<boolean>;
}) => (
  <Carousel.Root loop={loop} autoplay={autoplay}>
    ...
  </Carousel.Root>
);
```

The unavailable options are typed as the reason they are unavailable, so the compiler quotes it back at you instead of
saying "not assignable to type 'undefined'":

```tsx
<Carousel.Root loop autoplay={{ mode: "item", atEnd: "rewind" }} />
//                                            ^ Type '"rewind"' is not assignable to type
//                                              '"`atEnd` does not apply with loop: a looping
//                                                carousel never runs out of content"'
```

The same trick covers `speed` on a stepping mode, `interval` on a continuous one, and `pauseAtEnd` outside of
`mode: "continuous"`.

This ruling needs to know whether the carousel loops, so it only applies when `loop` is a literal. Given a `loop` that
resolves at runtime, `atEnd` and `pauseAtEnd` stay available: they do their job on the runs that come out non-looping,
and sit inert on the runs that do not.
