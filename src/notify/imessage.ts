// Versturen via Berichten (iMessage), met osascript.
// Overgenomen uit de galaxy-imessage-bridge (ouders), met dezelfde lessen:
//
//  1. Berichten kan maar één ding tegelijk. We versturen daarom strikt op
//     volgorde, één voor één, uit een wachtrij. Nooit een groepsgesprek:
//     dat is onbetrouwbaar.
//
//  2. Een ontvanger die nog nooit een gesprek met dit account heeft gehad,
//     bestaat voor Berichten niet. Dat is geen storing die overgaat, dus
//     niet opnieuw proberen. Andere fouten (Berichten start net op, even
//     geen netwerk) proberen we wél opnieuw.
//
//  3. Loopt een poging in de tijdslimiet, dan weten we NIET of het bericht
//     is aangekomen — het AppleEvent kan allang bij Berichten liggen.
//     Opnieuw proberen zou dan dubbele alarmen opleveren, dus dat doen we niet.

import { execFile } from 'child_process';
import { Logger } from 'homebridge';

const POGINGEN        = 3;
const PAUZES_S        = [5, 20];   // wachttijd vóór poging 2, 3
const TIJDSLIMIET_MS  = 30_000;

// AppleScript-tekst tussen dubbele aanhalingstekens: backslash en
// aanhalingsteken moeten ontsnapt, regeleinden worden \n. De tekst gaat
// niet door een shell (execFile zonder shell), dus verder niets ontzien.
function escapeAppleScript(tekst: string): string {
  return tekst
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
}

function bouwScript(nummer: string, tekst: string): string {
  return `tell application "Messages" to send "${escapeAppleScript(tekst)}" ` +
         `to buddy "${escapeAppleScript(nummer)}" of (service 1 whose service type is iMessage)`;
}

// Herkent de fout "deze ontvanger kent Berichten niet".
function isOnbekendeOntvanger(melding: string): boolean {
  const m = melding.toLowerCase();
  return m.includes('-1728')
      || m.includes('invalid index')
      || (m.includes('buddy') && m.includes("can't get"));
}

interface Uitslag {
  gelukt: boolean;
  melding?: string;
  blijvend?: boolean;        // ontvanger onbekend — herhalen heeft geen zin
  afloopOnbekend?: boolean;  // timeout — mogelijk wél bezorgd, niet herhalen
}

export class IMessageSender {
  private readonly rij: Array<{ nummer: string; tekst: string }> = [];
  private draait = false;

  constructor(private readonly log: Logger) {}

  // Zet hetzelfde bericht klaar voor alle ontvangers; elk krijgt zijn eigen
  // bericht, netjes achter elkaar. Vuurt en vergeet — fouten worden gelogd.
  send(nummers: string[], tekst: string): void {
    for (const nummer of nummers) {
      this.rij.push({ nummer, tekst });
    }
    void this.werkRijAf();
  }

  private async werkRijAf(): Promise<void> {
    if (this.draait) return;
    this.draait = true;
    while (this.rij.length > 0) {
      const { nummer, tekst } = this.rij.shift()!;
      try {
        await this.verstuurMetHerhaling(nummer, tekst);
      } catch (e) {
        this.log.error(`iMessage: onverwachte fout bij versturen naar ${nummer}: ${e}`);
      }
    }
    this.draait = false;
  }

  private async verstuurMetHerhaling(nummer: string, tekst: string): Promise<void> {
    for (let poging = 1; poging <= POGINGEN; poging++) {
      const uitslag = await this.eenPoging(nummer, tekst);

      if (uitslag.gelukt) {
        // osascript meldt alleen dat Berichten de opdracht heeft aangenomen;
        // of het bericht echt aankomt kunnen we hier niet zien.
        this.log.info(`iMessage: afgegeven aan Berichten voor ${nummer}${poging > 1 ? ` (poging ${poging})` : ''}`);
        return;
      }

      if (uitslag.afloopOnbekend) {
        this.log.warn(
          `iMessage: versturen naar ${nummer}: ${uitslag.melding}. Afloop onbekend — niet opnieuw ` +
          'geprobeerd om dubbele berichten te voorkomen. Controleer Berichten.');
        return;
      }

      if (uitslag.blijvend) {
        this.log.error(
          `iMessage: ${nummer} is bij Berichten niet bekend. Deze ontvanger moet eerst zelf ` +
          `een iMessage naar dit account sturen, anders komt er niets aan. (${uitslag.melding})`);
        return;
      }

      if (poging < POGINGEN) {
        const pauze = PAUZES_S[Math.min(poging - 1, PAUZES_S.length - 1)];
        this.log.warn(`iMessage: versturen naar ${nummer} mislukt (poging ${poging}): ${uitslag.melding} — over ${pauze}s opnieuw`);
        await new Promise(r => setTimeout(r, pauze * 1000));
      } else {
        this.log.error(`iMessage: versturen naar ${nummer} definitief opgegeven na ${POGINGEN} pogingen: ${uitslag.melding}`);
      }
    }
  }

  private eenPoging(nummer: string, tekst: string): Promise<Uitslag> {
    return new Promise((klaar) => {
      execFile('osascript', ['-e', bouwScript(nummer, tekst)],
        { timeout: TIJDSLIMIET_MS },
        (err, _stdout, stderr) => {
          if (!err) return klaar({ gelukt: true });

          if (err.killed || err.signal === 'SIGTERM') {
            return klaar({ gelukt: false, afloopOnbekend: true, melding: `geen antwoord binnen ${TIJDSLIMIET_MS / 1000}s` });
          }

          const melding = (stderr || err.message || '').trim();
          klaar({ gelukt: false, melding, blijvend: isOnbekendeOntvanger(melding) });
        });
    });
  }
}
