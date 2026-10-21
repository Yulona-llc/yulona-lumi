import { animate, motion, MotionConfig, useInView, useMotionValue, useReducedMotion, useTransform, type Variants } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/** Respect the OS "reduce motion" setting everywhere motion is used. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export const ease = [0.22, 1, 0.36, 1] as const;

/** Route-level transition: a 6px rise. Opacity is never animated: a paused animation (background tab) must not leave a page invisible. */
export function PageTransition({ children, id }: { children: ReactNode; id: string }) {
  return (
    <motion.div key={id} initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.22, ease }}>
      {children}
    </motion.div>
  );
}

const list: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.045 } } };
const row: Variants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.25, ease } } };

/** Stagger children in once (lists, grids). Wrap items in <StaggerItem>. */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return <motion.div className={className} variants={list} initial="hidden" animate="show">{children}</motion.div>;
}
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return <motion.div className={className} variants={row}>{children}</motion.div>;
}

/** Count up to `value` when it first scrolls into view (KPIs). Renders the final number immediately for reduced motion. */
export function AnimatedNumber({ value, format = (n: number) => Math.round(n).toLocaleString(), className }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const reduce = useReducedMotion();
  const mv = useMotionValue(reduce ? value : 0);
  const text = useTransform(mv, (n) => format(n));
  useEffect(() => {
    if (!inView || reduce) { mv.set(value); return; }
    const c = animate(mv, value, { duration: 0.9, ease });
    return () => c.stop();
  }, [inView, value, reduce, mv]);
  return <motion.span ref={ref} className={className}>{text}</motion.span>;
}

export { motion };
