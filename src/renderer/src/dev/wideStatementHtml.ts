// Development and tests only: a made-up trading statement shaped like a MetaTrader daily report:
// fixed-width tables (about 1000 px), cells that never wrap, colspans and right-aligned bold labels.
// Everything here is invented (the company is not real).
let NOWRAP = true;
const th = (t: string, extra = ''): string =>
  `<th style="background:#e5e5e5;border:1px solid #c0c0c0;padding:3px 6px;${NOWRAP ? 'white-space:nowrap;' : ''}font:bold 11px Tahoma,Arial,sans-serif;text-align:left"${extra}>${t}</th>`;
const td = (t: string, align = 'left', extra = ''): string =>
  `<td${NOWRAP ? ' nowrap' : ''} style="padding:3px 6px;${NOWRAP ? 'white-space:nowrap;' : ''}font:11px Tahoma,Arial,sans-serif;text-align:${align}"${extra}>${t}</td>`;
const lab = (t: string): string =>
  `<td${NOWRAP ? ' nowrap' : ''} colspan="3" align="right" style="padding:3px 6px;${NOWRAP ? 'white-space:nowrap;' : ''}font:bold 11px Tahoma,Arial,sans-serif;text-align:right">${t}:</td>`;

export const WIDE_LAST_COLUMN = 'Market Price';

/** nowrap:false is the same report without "no wrap" cells (they may break at spaces, so the table can squeeze). */
export function wideStatementHtml(opts: { nowrap?: boolean } = {}): string {
  NOWRAP = opts.nowrap !== false;
  const head = [
    'Ticket',
    'Open Time',
    'Type',
    'Size',
    'Item',
    'Price',
    'S / L',
    'T / P',
    'Close Time',
    'Price',
    'Commission',
    'Swap',
    'Profit',
    'State',
    'Entry',
    'Fee',
    'Comment',
    WIDE_LAST_COLUMN,
  ];
  const rows: string[] = [];
  for (let i = 0; i < 8; i++) {
    rows.push(
      `<tr>${td(String(81230000 + i))}${td('2026.10.09 14:0' + i)}${td(i % 2 ? 'sell' : 'buy')}${td('0.10', 'right')}${td('xauusd')}${td('4195.10', 'right')}${td('0.00', 'right')}${td('0.00', 'right')}${td('2026.10.09 16:3' + i)}${td('4198.40', 'right')}${td('-0.69', 'right')}${td('0.00', 'right')}${td('33.00', 'right')}${td('Filled')}${td('out')}${td('0.00', 'right')}${td('[sl 4190.00]')}${td('4198.40', 'right')}</tr>`,
    );
  }
  const totals = ['Deposit/Withdrawal', 'Credit', 'Round Commission', 'Floating P/L', 'Balance'];
  return (
    '<div style="font:11px Tahoma,Arial,sans-serif;color:#000">' +
    '<table width="1000" cellspacing="1" cellpadding="3" border="0" style="width:1000px">' +
    `<tr><td colspan="18" align="center" style="font:bold 14px Tahoma,Arial,sans-serif;${NOWRAP ? 'white-space:nowrap' : ''}">Northgate Markets Ltd &mdash; Daily Confirmation</td></tr>` +
    `<tr><td${NOWRAP ? ' nowrap' : ''} colspan="9"><b>Account:</b> 5550123 &nbsp; <b>Name:</b> Anna Rossi</td><td${NOWRAP ? ' nowrap' : ''} colspan="9" align="right"><b>Currency:</b> USD &nbsp; <b>Date:</b> 2026 October 09</td></tr>` +
    `<tr>${head.map((h) => th(h)).join('')}</tr>${rows.join('')}</table>` +
    '<br><table width="1000" cellspacing="1" cellpadding="3" border="0" style="width:1000px">' +
    totals
      .map(
        (t, i) =>
          `<tr>${lab(t)}${td((i * 1234.56 - 0.69).toFixed(2), 'right')}<td colspan="14"></td></tr>`,
      )
      .join('') +
    '</table></div>'
  );
}
