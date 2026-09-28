// Текст файла в сборке main (`?raw` у Vite): tsconfig.node.json берёт типы electron-vite/node, а
// `*?raw` объявлен только в vite/client — без этого pnpm typecheck упал бы на импорте guest-pick.js.
declare module '*?raw' {
  const text: string;
  export default text;
}
