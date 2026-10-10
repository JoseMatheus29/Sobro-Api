// Mesma dobra de texto de utils/search.ts: minúsculas e sem acento, para "alimentacao" achar "Alimentação".
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// As palavras da busca; cada uma precisa aparecer no nome, na descrição, na categoria ou na conta.
export function searchWords(text: string, max = 8): string[] {
  return foldText(text).split(/\s+/).filter(Boolean).slice(0, max);
}

// Escapa os curingas do LIKE para a palavra ser procurada literalmente.
export function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (c) => '\\' + c);
}
