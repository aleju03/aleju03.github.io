/** Lives apart from i18n.tsx so pure-data modules (and vite.config's llms.txt
 *  generation) can type against it without pulling the JSX dictionary module
 *  into their type program. */
export type Language = 'en' | 'es'
