# homebridge-galaxy-flex

**HomeBridge Plugin om je Honeywell Galaxy Flex alarmsysteem volledig toe te voegen aan Apple HomeKit (Apple Home App).**

Honeywell heeft de gratis pushnotificatiedienst voor de Galaxy Flex stopgezet. Deze HomeBridge plugin vervangt die dienst — en gaat verder. Alarm aan en uit via Siri, pushberichten bij brand of inbraak, live status van elke zone in de Apple Home app. Allemaal gratis, self-hosted, zonder abonnement.

Via een directe API-koppeling met Philips Hue kan de plugin bij een alarm automatisch de verlichting in huis aansturen — denk aan alle lampen fel wit bij brand, of knipperende rode lampen bij inbraak. Na het resetten van het alarm keert de verlichting automatisch terug naar de oorspronkelijke staat.

---

## ✨ Wat kun je ermee?

- 🔔 **Pushnotificaties** bij inbraak, brand of paniek — via Apple Home, op elk apparaat in je huishouden
- 🏠 **Alarm in- en uitschakelen** via de Apple Home app of Siri
- 🚪 **Live zone-status** — zie precies welke deur, raam of bewegingssensor actief is
- 🌙 **Nacht, Thuis en Afwezig** — alle vier HomeKit standen ondersteund
- 💡 **Hue alarmlichten** — lampen gaan automatisch aan bij alarm, keren daarna terug naar de oude stand
- 👤 **Wie heeft wat gedaan** — aparte sensor per gebruiker voor gepersonaliseerde meldingen
- 📊 **Live dashboard** in HomeBridge met alarmstatus, zones en verbindingsinfo

---

## 🔧 Twee routes

### Route 1 — SIA-only (zonder extra hardware)
Sluit de plugin aan op de Ethernet-module van de Galaxy Flex. Je ontvangt alarmgebeurtenissen via het Galaxy proprietary protocol en krijgt pushberichten in Apple Home.

**✓ Pushnotificaties** · **✗ Live zone-status** · **✗ Bediening via HomeKit**

### Route 2 — Volledig (met Seasoft Galaxy Gateway)
Voeg een [Seasoft Galaxy Gateway](https://seasoft.nl) toe. Deze module communiceert via de Ethernet-module met het paneel en biedt live zone-status én bediening vanuit HomeKit.

**✓ Pushnotificaties** · **✓ Live zone-status** · **✓ Arm/disarm via HomeKit**

> De Seasoft module kost circa €150-200 en is eenvoudig te koppelen. De plugin configureert de module automatisch.

---

## 📋 Vereisten

- [HomeBridge](https://homebridge.io) v2.0 of hoger
- Node.js v18 of hoger
- Honeywell Galaxy Flex alarmpaneel met Ethernet-module (A083-00-10)
- *(optioneel)* [Seasoft Galaxy Gateway](https://seasoft.nl) voor volledige integratie

---

## 🚀 Installatie

```bash
npm install -g homebridge-galaxy-flex
```

Of via de HomeBridge Config UI: zoek op **Galaxy Flex** en installeer.

---

## ⚙️ Configuratie

Open de plugin in HomeBridge en ga naar **Instellingen**. De plugin heeft een ingebouwde installatiewizard die je stap voor stap door de setup leidt — inclusief automatische configuratie van de Seasoft module.

### Alarm panel (eenmalig, via installateursmenu)

| Instelling | Waarde |
|---|---|
| Menu 56 → Slot 1 → Format | SIA Level 4 |
| Menu 56 → Slot 1 → IP | IP-adres van je HomeBridge server |
| Menu 56 → Slot 1 → Poort | 52000 |
| Encryptie (Alarm Report) | Uit |

### Plugin config (minimaal)

```json
{
  "platform": "GalaxyFlex",
  "name": "Galaxy Flex",
  "port": 52000,
  "account": "jouw-accountnummer",
  "seasoftEnabled": false
}
```

### Met Seasoft module

```json
{
  "platform": "GalaxyFlex",
  "name": "Galaxy Flex",
  "port": 52000,
  "account": "jouw-accountnummer",
  "seasoftEnabled": true,
  "seasoftIp": "192.168.x.x"
}
```

Alle overige instellingen (MQTT, Hue, gebruikers, zones) zijn instelbaar via het dashboard in HomeBridge.

---

## 🏗️ Architectuur

```
Honeywell Galaxy Flex
    │
    ├── Ethernet-module ──► HomeBridge (SIA events, poort 52000)
    │
    └── Ethernet-module ──► Seasoft Gateway ──► MQTT ──► HomeBridge
                                                          │
                                              Apple HomeKit / Home app
```

---

## 📦 Wat zit er in de plugin?

| Component | Beschrijving |
|---|---|
| SIA receiver | Luistert op poort 52000 naar Galaxy proprietary protocol |
| Embedded MQTT broker | Ingebouwde broker op poort 1883, geen externe installatie |
| Seasoft client | Subscribeert op zone- en groepsstatus via MQTT |
| SecuritySystem | HomeKit accessory voor alarm aan/uit/nacht/thuis |
| Zone sensors | Contact, beweging en rookmelders als HomeKit accessories |
| Gebruikersensoren | ContactSensor per gebruiker voor gepersonaliseerde meldingen |
| Hue alarmlichten | Snapshot → alarm scène → automatisch herstel |
| Custom dashboard | Live status in HomeBridge UI |

---

## 🤝 Bijdragen

Deze plugin is gebouwd op basis van mijn eigen wensen en hardware setup. Suggesties zijn altijd welkom, maar houd er rekening mee dat nieuwe features primair worden beoordeeld op basis van mijn eigen gebruik. Goede ideeën worden zeker overwogen!

---

## 📄 Licentie

MIT
