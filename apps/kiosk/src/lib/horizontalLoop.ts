/**
 * horizontalLoop — GSAP's official seamless-loop helper (greensock.com/docs/v3/HelperFunctions),
 * as used by the Osmo "Draggable Infinite Slider" (codepen.io/osmosupply/pen/NPKqByd). Ported
 * verbatim except: TypeScript wrapper, plugins imported from the npm package (free since GSAP
 * 3.13), and the internal gsap.context is returned (as `loop.context`) so React can revert it
 * on unmount. Builds an infinite, draggable, inertia-snapping timeline over a row of items.
 *
 * The helper is intentionally low-level and dynamically augments the timeline (toIndex/next/
 * previous/closestIndex), so its internals are typed loosely.
 */
import { gsap } from "gsap";
import { Draggable } from "gsap/Draggable";
import { InertiaPlugin } from "gsap/InertiaPlugin";

gsap.registerPlugin(Draggable, InertiaPlugin);

export interface HorizontalLoopConfig {
  paused?: boolean;
  draggable?: boolean;
  center?: boolean | string;
  speed?: number;
  repeat?: number;
  reversed?: boolean;
  snap?: number | false;
  paddingRight?: number | string;
  onChange?: (element: Element, index: number) => void;
}

// reason: the helper augments the gsap timeline with custom methods (toIndex, next, …) and
// works with heterogeneous dynamic arrays; a precise type would obscure the ported algorithm.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function horizontalLoop(rawItems: any, config?: HorizontalLoopConfig): any {
  let timeline: any;
  const items: any[] = gsap.utils.toArray(rawItems);
  config = config || {};
  const ctx = gsap.context(() => {
    const onChange = config!.onChange;
    let lastIndex = 0;
    const tl: any = gsap.timeline({
      repeat: config!.repeat,
      onUpdate:
        onChange &&
        function () {
          const i = tl.closestIndex();
          if (lastIndex !== i) {
            lastIndex = i;
            onChange(items[i], i);
          }
        },
      paused: config!.paused,
      defaults: { ease: "none" },
      onReverseComplete: () => tl.totalTime(tl.rawTime() + tl.duration() * 100),
    });
    const length = items.length;
    const startX = items[0].offsetLeft;
    const times: number[] = [];
    const widths: number[] = [];
    const spaceBefore: number[] = [];
    const xPercents: number[] = [];
    let curIndex = 0;
    let indexIsDirty = false;
    const center = config!.center;
    const pixelsPerSecond = (config!.speed || 1) * 100;
    // some browsers shift by a pixel to accommodate flex layouts, so we snap to make it natural
    const snap =
      config!.snap === false ? (v: number) => v : gsap.utils.snap((config!.snap as number) || 1);
    let timeOffset = 0;
    const container =
      center === true
        ? items[0].parentNode
        : (gsap.utils.toArray(center as any)[0] as any) || items[0].parentNode;
    let totalWidth: number;
    const getTotalWidth = () =>
      items[length - 1].offsetLeft +
      (xPercents[length - 1]! / 100) * widths[length - 1]! -
      startX +
      spaceBefore[0]! +
      items[length - 1].offsetWidth * (gsap.getProperty(items[length - 1], "scaleX") as number) +
      (parseFloat(config!.paddingRight as string) || 0);
    const populateWidths = () => {
      let b1 = container.getBoundingClientRect();
      let b2: DOMRect;
      items.forEach((el, i) => {
        widths[i] = parseFloat(gsap.getProperty(el, "width", "px") as string);
        xPercents[i] = snap(
          (parseFloat(gsap.getProperty(el, "x", "px") as string) / widths[i]!) * 100 +
            (gsap.getProperty(el, "xPercent") as number),
        );
        b2 = el.getBoundingClientRect();
        spaceBefore[i] = b2.left - (i ? b1.right : b1.left);
        b1 = b2;
      });
      gsap.set(items, { xPercent: (i: number) => xPercents[i]! });
      totalWidth = getTotalWidth();
    };
    let timeWrap: (v: number) => number;
    const populateOffsets = () => {
      timeOffset = center ? (tl.duration() * (container.offsetWidth / 2)) / totalWidth : 0;
      center &&
        times.forEach((_t, i) => {
          times[i] = timeWrap(
            tl.labels["label" + i] + (tl.duration() * widths[i]!) / 2 / totalWidth - timeOffset,
          );
        });
    };
    const getClosest = (values: number[], value: number, wrap: number) => {
      let i = values.length;
      let closest = 1e10;
      let index = 0;
      let d: number;
      while (i--) {
        d = Math.abs(values[i]! - value);
        if (d > wrap / 2) d = wrap - d;
        if (d < closest) {
          closest = d;
          index = i;
        }
      }
      return index;
    };
    const populateTimeline = () => {
      let i: number;
      let item: any;
      let curX: number;
      let distanceToStart: number;
      let distanceToLoop: number;
      tl.clear();
      for (i = 0; i < length; i++) {
        item = items[i];
        curX = (xPercents[i]! / 100) * widths[i]!;
        distanceToStart = item.offsetLeft + curX - startX + spaceBefore[0]!;
        distanceToLoop = distanceToStart + widths[i]! * (gsap.getProperty(item, "scaleX") as number);
        tl.to(
          item,
          { xPercent: snap(((curX - distanceToLoop) / widths[i]!) * 100), duration: distanceToLoop / pixelsPerSecond },
          0,
        )
          .fromTo(
            item,
            { xPercent: snap(((curX - distanceToLoop + totalWidth) / widths[i]!) * 100) },
            {
              xPercent: xPercents[i]!,
              duration: (curX - distanceToLoop + totalWidth - curX) / pixelsPerSecond,
              immediateRender: false,
            },
            distanceToLoop / pixelsPerSecond,
          )
          .add("label" + i, distanceToStart / pixelsPerSecond);
        times[i] = distanceToStart / pixelsPerSecond;
      }
      timeWrap = gsap.utils.wrap(0, tl.duration());
    };
    const refresh = (deep?: boolean) => {
      const progress = tl.progress();
      tl.progress(0, true);
      populateWidths();
      deep && populateTimeline();
      populateOffsets();
      deep && tl.draggable ? tl.time(times[curIndex]!, true) : tl.progress(progress, true);
    };
    const onResize = () => refresh(true);
    let proxy: any;
    gsap.set(items, { x: 0 });
    populateWidths();
    populateTimeline();
    populateOffsets();
    window.addEventListener("resize", onResize);
    function toIndex(index: number, vars?: any) {
      vars = vars || {};
      Math.abs(index - curIndex) > length / 2 && (index += index > curIndex ? -length : length);
      const newIndex = gsap.utils.wrap(0, length, index);
      let time = times[newIndex]!;
      if (time > tl.time() !== index > curIndex && index !== curIndex) {
        time += tl.duration() * (index > curIndex ? 1 : -1);
      }
      if (time < 0 || time > tl.duration()) vars.modifiers = { time: timeWrap };
      curIndex = newIndex;
      vars.overwrite = true;
      gsap.killTweensOf(proxy);
      return vars.duration === 0 ? tl.time(timeWrap(time)) : tl.tweenTo(time, vars);
    }
    tl.toIndex = (index: number, vars?: any) => toIndex(index, vars);
    tl.closestIndex = (setCurrent?: boolean) => {
      const index = getClosest(times, tl.time(), tl.duration());
      if (setCurrent) {
        curIndex = index;
        indexIsDirty = false;
      }
      return index;
    };
    tl.current = () => (indexIsDirty ? tl.closestIndex(true) : curIndex);
    tl.next = (vars?: any) => toIndex(tl.current() + 1, vars);
    tl.previous = (vars?: any) => toIndex(tl.current() - 1, vars);
    tl.times = times;
    tl.progress(1, true).progress(0, true); // pre-render for performance
    if (config!.reversed) {
      tl.vars.onReverseComplete();
      tl.reverse();
    }
    if (config!.draggable && typeof Draggable === "function") {
      proxy = document.createElement("div");
      const wrap = gsap.utils.wrap(0, 1);
      let ratio: number;
      let startProgress: number;
      let draggable: any;
      let lastSnap: number;
      let initChangeX: number;
      let wasPlaying: boolean;
      const align = () =>
        tl.progress(wrap(startProgress + (draggable.startX - draggable.x) * ratio));
      const syncIndex = () => tl.closestIndex(true);
      draggable = Draggable.create(proxy, {
        trigger: items[0].parentNode,
        type: "x",
        onPressInit() {
          const x = (this as any).x;
          gsap.killTweensOf(tl);
          wasPlaying = !tl.paused();
          tl.pause();
          startProgress = tl.progress();
          refresh();
          ratio = 1 / totalWidth;
          initChangeX = startProgress / -ratio - x;
          gsap.set(proxy, { x: startProgress / -ratio });
        },
        onDrag: align,
        onThrowUpdate: align,
        overshootTolerance: 0,
        inertia: true,
        snap(value: number) {
          if (Math.abs(startProgress / -ratio - (this as any).x) < 10) return lastSnap + initChangeX;
          const time = -(value * ratio) * tl.duration();
          const wrappedTime = timeWrap(time);
          const snapTime = times[getClosest(times, wrappedTime, tl.duration())]!;
          let dif = snapTime - wrappedTime;
          Math.abs(dif) > tl.duration() / 2 && (dif += dif < 0 ? tl.duration() : -tl.duration());
          lastSnap = (time + dif) / tl.duration() / -ratio;
          return lastSnap;
        },
        onRelease() {
          syncIndex();
          (this as any).isThrowing && (indexIsDirty = true);
        },
        onThrowComplete: () => {
          syncIndex();
          wasPlaying && tl.play();
        },
      })[0];
      tl.draggable = draggable;
    }
    tl.closestIndex(true);
    lastIndex = curIndex;
    onChange && onChange(items[curIndex], curIndex);
    timeline = tl;
    return () => window.removeEventListener("resize", onResize);
  });
  timeline.context = ctx;
  return timeline;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
