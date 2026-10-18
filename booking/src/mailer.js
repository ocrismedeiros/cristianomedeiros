import nodemailer from 'nodemailer';
import { formatRange } from './time.js';

export function createMailer({ env, log = console }) {
  const transport = env.SMTP_HOST
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT || 465),
        secure: Number(env.SMTP_PORT || 465) === 465,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      })
    : null;

  async function send(msg) {
    if (!transport) {
      log.info(`[mail:dev] Para: ${msg.to}\nAssunto: ${msg.subject}\n${msg.text}\n`);
      return;
    }
    await transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, ...msg });
  }

  return { send, verify: () => transport?.verify() };
}

// --- message templates ------------------------------------------------------

const KIND = {
  booked: { visitor: 'Reunião confirmada', owner: 'Nova reserva' },
  rescheduled: { visitor: 'Reunião reagendada', owner: 'Reserva reagendada' },
  cancelled: { visitor: 'Reunião cancelada', owner: 'Reserva cancelada' },
};

/**
 * Build the visitor + owner emails for a booking event.
 * kind: 'booked' | 'rescheduled' | 'cancelled'; previous: { start_ms, end_ms } for reschedules.
 */
export function bookingEmails({ kind, booking, previous, manageUrl, config, env }) {
  const locale = config.locale || 'pt-BR';
  const owner = config.owner.name;
  const when = (tz, b = booking) => formatRange(b.start_ms, b.end_ms, tz, locale);
  const active = kind !== 'cancelled';

  const lines = (tz, forOwner) => [
    forOwner ? `Convidado: ${booking.name} <${booking.email}>` : `Com: ${owner}`,
    `Quando: ${when(tz)}`,
    previous ? `Antes: ${when(tz, previous)}` : null,
    active && booking.meet_link ? `Google Meet: ${booking.meet_link}` : null,
    booking.note ? `Nota: ${booking.note}` : null,
    forOwner && booking.google_error ? `⚠ Falha no Google Calendar: ${booking.google_error}` : null,
    '',
    active ? `Reagendar: ${manageUrl}/reschedule` : null,
    active ? `Cancelar: ${manageUrl}/cancel` : null,
    !active && !forOwner ? `Agendar outro horário: ${env.PUBLIC_URL}/` : null,
  ].filter((l) => l !== null).join('\n');

  return [
    {
      to: booking.email,
      subject: `${KIND[kind].visitor}: ${config.meeting.title}`,
      text: `Olá, ${booking.name}.\n\n${lines(booking.visitor_tz, false)}\n`,
    },
    {
      to: env.OWNER_EMAIL,
      replyTo: booking.email,
      subject: `${KIND[kind].owner}: ${booking.name} · ${when(config.timezone)}`,
      text: `${lines(config.timezone, true)}\n`,
    },
  ].filter((m) => m.to);
}
