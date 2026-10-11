/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {
  compilerOptions: {
    // Runes mode for every project component (§7.2). Libraries in node_modules keep inferring their own mode.
    runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
  },
}
