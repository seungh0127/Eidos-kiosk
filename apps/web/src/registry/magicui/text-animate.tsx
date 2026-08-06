import { useEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

export type TextAnimateProps = HTMLAttributes<HTMLSpanElement> & {
  animation?: "blurInUp";
  by?: "character" | "word";
  once?: boolean;
  children: ReactNode;
};

/** Lightweight local equivalent of Magic UI's character text animation. */
export function TextAnimate({
  animation = "blurInUp",
  by = "character",
  once = false,
  children,
  className = "",
  ...props
}: TextAnimateProps) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const units = by === "word" ? text.split(/(\s+)/) : Array.from(text);
  const [complete, setComplete] = useState(!once);

  useEffect(() => {
    if (!once) {
      setComplete(true);
      return;
    }
    setComplete(false);
    const revealDuration = Math.max(0, (units.length - 1) * 28) + 620;
    const timer = window.setTimeout(() => setComplete(true), revealDuration);
    return () => window.clearTimeout(timer);
  }, [by, once, text, units.length]);

  return <span {...props} className={`text-animate text-animate-${animation} ${once ? "text-animate-once" : ""} ${complete ? "text-animate-complete" : ""} ${className}`.trim()}>
    {complete ? text : units.map((unit, index) => <span className="text-animate-item" style={{ "--text-animate-delay": `${index * 28}ms` } as CSSProperties} key={`${index}-${unit}`}>
      {unit === " " ? "\u00a0" : unit}
    </span>)}
  </span>;
}
