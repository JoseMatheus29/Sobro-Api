export interface Mailer {
  sendPasswordReset(to: string, link: string): Promise<void>;
}

// Resend pela API HTTP (hospedagens como o Render bloqueiam SMTP).
export function createResendMailer(apiKey: string, from: string): Mailer {
  return {
    async sendPasswordReset(to, link) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to,
          subject: 'Redefinir sua senha do Sobrô?',
          text: `Para criar uma nova senha, abra o link (vale por pouco tempo e só funciona uma vez):\n\n${link}\n\nSe não foi você, ignore este e-mail.`,
        }),
      });
      if (!response.ok) throw new Error(`Resend respondeu ${response.status}`);
    },
  };
}

// Sem chave configurada: só o desenvolvimento local imprime o link (que carrega o token).
export function createConsoleMailer(log: (message: string) => void): Mailer {
  return {
    async sendPasswordReset(to, link) {
      log(`[mail] redefinição de senha para ${to}: ${link}`);
    },
  };
}
