import { motion, useScroll } from 'motion/react'

/* Thin page-scroll progress bar; orientation feedback for the long page. */
export function Progress() {
  const { scrollYProgress } = useScroll()
  return (
    <motion.div
      aria-hidden
      style={{ scaleX: scrollYProgress }}
      className="fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-blue-600 dark:bg-blue-400"
    />
  )
}
