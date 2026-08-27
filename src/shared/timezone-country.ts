/**
 * Country from the machine's own timezone — the whole point being that it takes
 * NO network call and no third-party geolocation service.
 *
 * dev-3.0 used to look the user's public IP up at ipify and hand it to GA as
 * `ip_override`; that was removed (see
 * decisions/2026/08/27/drop-ip-override-geolocation.md). Country is still worth
 * knowing, and the machine already holds enough to answer it: `Asia/Jerusalem`
 * means Israel, and nothing about the user leaves the machine to establish that.
 *
 * THE TABLE IS BAKED IN RATHER THAN DERIVED AT RUNTIME. The platform has only the
 * reverse lookup (`Intl.Locale.prototype.getTimeZones()`, region → zones), and it
 * does not exist everywhere dev3 runs — Node 22 has no such method at all, and it
 * only reached Chrome in late 2024. Sweeping for it would also cost ~100 ms on
 * every engine that does have it. A generated constant is the same answer,
 * instantly, everywhere, and it can actually be tested.
 *
 * Regenerate with `bun scripts/generate-timezone-countries.ts` when tzdata gains
 * a zone; a missing zone degrades to "no country", never to a wrong one.
 */

/** `<region>:<zone>,<zone>|<region>:…`, sorted, generated from CLDR. */
const PACKED =
	"AD:Europe/Andorra|AE:Asia/Dubai|AF:Asia/Kabul|AG:America/Antigua|AI:America/Anguilla|AL:Europe/Tiran" +
	"e|AM:Asia/Yerevan|AO:Africa/Luanda|AQ:Antarctica/Casey,Antarctica/Davis,Antarctica/DumontDUrville,An" +
	"tarctica/Mawson,Antarctica/McMurdo,Antarctica/Palmer,Antarctica/Rothera,Antarctica/Syowa,Antarctica/" +
	"Troll,Antarctica/Vostok|AR:America/Argentina/Buenos_Aires,America/Argentina/Catamarca,America/Argent" +
	"ina/Cordoba,America/Argentina/Jujuy,America/Argentina/La_Rioja,America/Argentina/Mendoza,America/Arg" +
	"entina/Rio_Gallegos,America/Argentina/Salta,America/Argentina/San_Juan,America/Argentina/San_Luis,Am" +
	"erica/Argentina/Tucuman,America/Argentina/Ushuaia,America/Buenos_Aires,America/Catamarca,America/Cor" +
	"doba,America/Jujuy,America/Mendoza|AS:Pacific/Pago_Pago|AT:Europe/Vienna|AU:Antarctica/Macquarie,Aus" +
	"tralia/Adelaide,Australia/Brisbane,Australia/Broken_Hill,Australia/Darwin,Australia/Eucla,Australia/" +
	"Hobart,Australia/Lindeman,Australia/Lord_Howe,Australia/Melbourne,Australia/Perth,Australia/Sydney|A" +
	"W:America/Aruba|AX:Europe/Mariehamn|AZ:Asia/Baku|BA:Europe/Sarajevo|BB:America/Barbados|BD:Asia/Dhak" +
	"a|BE:Europe/Brussels|BF:Africa/Ouagadougou|BG:Europe/Sofia|BH:Asia/Bahrain|BI:Africa/Bujumbura|BJ:Af" +
	"rica/Porto-Novo|BL:America/St_Barthelemy|BM:Atlantic/Bermuda|BN:Asia/Brunei|BO:America/La_Paz|BQ:Ame" +
	"rica/Kralendijk|BR:America/Araguaina,America/Bahia,America/Belem,America/Boa_Vista,America/Campo_Gra" +
	"nde,America/Cuiaba,America/Eirunepe,America/Fortaleza,America/Maceio,America/Manaus,America/Noronha," +
	"America/Porto_Velho,America/Recife,America/Rio_Branco,America/Santarem,America/Sao_Paulo|BS:America/" +
	"Nassau|BT:Asia/Thimphu|BW:Africa/Gaborone|BY:Europe/Minsk|BZ:America/Belize|CA:America/Atikokan,Amer" +
	"ica/Blanc-Sablon,America/Cambridge_Bay,America/Coral_Harbour,America/Creston,America/Dawson,America/" +
	"Dawson_Creek,America/Edmonton,America/Fort_Nelson,America/Glace_Bay,America/Goose_Bay,America/Halifa" +
	"x,America/Inuvik,America/Iqaluit,America/Moncton,America/Rankin_Inlet,America/Regina,America/Resolut" +
	"e,America/St_Johns,America/Swift_Current,America/Toronto,America/Vancouver,America/Whitehorse,Americ" +
	"a/Winnipeg|CC:Indian/Cocos|CD:Africa/Kinshasa,Africa/Lubumbashi|CF:Africa/Bangui|CG:Africa/Brazzavil" +
	"le|CH:Europe/Zurich|CI:Africa/Abidjan|CK:Pacific/Rarotonga|CL:America/Coyhaique,America/Punta_Arenas" +
	",America/Santiago,Pacific/Easter|CM:Africa/Douala|CN:Asia/Shanghai,Asia/Urumqi|CO:America/Bogota|CR:" +
	"America/Costa_Rica|CU:America/Havana|CV:Atlantic/Cape_Verde|CW:America/Curacao|CX:Indian/Christmas|C" +
	"Y:Asia/Famagusta,Asia/Nicosia|CZ:Europe/Prague|DE:Europe/Berlin,Europe/Busingen|DJ:Africa/Djibouti|D" +
	"K:Europe/Copenhagen|DM:America/Dominica|DO:America/Santo_Domingo|DZ:Africa/Algiers|EC:America/Guayaq" +
	"uil,Pacific/Galapagos|EE:Europe/Tallinn|EG:Africa/Cairo|EH:Africa/El_Aaiun|ER:Africa/Asmara,Africa/A" +
	"smera|ES:Africa/Ceuta,Atlantic/Canary,Europe/Madrid|ET:Africa/Addis_Ababa|FI:Europe/Helsinki|FJ:Paci" +
	"fic/Fiji|FK:Atlantic/Stanley|FM:Pacific/Chuuk,Pacific/Kosrae,Pacific/Pohnpei,Pacific/Ponape,Pacific/" +
	"Truk|FO:Atlantic/Faeroe,Atlantic/Faroe|FR:Europe/Paris|GA:Africa/Libreville|GB:Europe/London|GD:Amer" +
	"ica/Grenada|GE:Asia/Tbilisi|GF:America/Cayenne|GG:Europe/Guernsey|GH:Africa/Accra|GI:Europe/Gibralta" +
	"r|GL:America/Danmarkshavn,America/Godthab,America/Nuuk,America/Scoresbysund,America/Thule|GM:Africa/" +
	"Banjul|GN:Africa/Conakry|GP:America/Guadeloupe|GQ:Africa/Malabo|GR:Europe/Athens|GS:Atlantic/South_G" +
	"eorgia|GT:America/Guatemala|GU:Pacific/Guam|GW:Africa/Bissau|GY:America/Guyana|HK:Asia/Hong_Kong|HN:" +
	"America/Tegucigalpa|HR:Europe/Zagreb|HT:America/Port-au-Prince|HU:Europe/Budapest|ID:Asia/Jakarta,As" +
	"ia/Jayapura,Asia/Makassar,Asia/Pontianak|IE:Europe/Dublin|IL:Asia/Jerusalem|IM:Europe/Isle_of_Man|IN" +
	":Asia/Calcutta,Asia/Kolkata|IO:Indian/Chagos|IQ:Asia/Baghdad|IR:Asia/Tehran|IS:Atlantic/Reykjavik|IT" +
	":Europe/Rome|JE:Europe/Jersey|JM:America/Jamaica|JO:Asia/Amman|JP:Asia/Tokyo|KE:Africa/Nairobi|KG:As" +
	"ia/Bishkek|KH:Asia/Phnom_Penh|KI:Pacific/Enderbury,Pacific/Kanton,Pacific/Kiritimati,Pacific/Tarawa|" +
	"KM:Indian/Comoro|KN:America/St_Kitts|KP:Asia/Pyongyang|KR:Asia/Seoul|KW:Asia/Kuwait|KY:America/Cayma" +
	"n|KZ:Asia/Almaty,Asia/Aqtau,Asia/Aqtobe,Asia/Atyrau,Asia/Oral,Asia/Qostanay,Asia/Qyzylorda|LA:Asia/V" +
	"ientiane|LB:Asia/Beirut|LC:America/St_Lucia|LI:Europe/Vaduz|LK:Asia/Colombo|LR:Africa/Monrovia|LS:Af" +
	"rica/Maseru|LT:Europe/Vilnius|LU:Europe/Luxembourg|LV:Europe/Riga|LY:Africa/Tripoli|MA:Africa/Casabl" +
	"anca|MC:Europe/Monaco|MD:Europe/Chisinau|ME:Europe/Podgorica|MF:America/Marigot|MG:Indian/Antananari" +
	"vo|MH:Pacific/Kwajalein,Pacific/Majuro|MK:Europe/Skopje|ML:Africa/Bamako|MM:Asia/Rangoon,Asia/Yangon" +
	"|MN:Asia/Hovd,Asia/Ulaanbaatar|MO:Asia/Macau|MP:Pacific/Saipan|MQ:America/Martinique|MR:Africa/Nouak" +
	"chott|MS:America/Montserrat|MT:Europe/Malta|MU:Indian/Mauritius|MV:Indian/Maldives|MW:Africa/Blantyr" +
	"e|MX:America/Bahia_Banderas,America/Cancun,America/Chihuahua,America/Ciudad_Juarez,America/Hermosill" +
	"o,America/Matamoros,America/Mazatlan,America/Merida,America/Mexico_City,America/Monterrey,America/Oj" +
	"inaga,America/Tijuana|MY:Asia/Kuala_Lumpur,Asia/Kuching|MZ:Africa/Maputo|NA:Africa/Windhoek|NC:Pacif" +
	"ic/Noumea|NE:Africa/Niamey|NF:Pacific/Norfolk|NG:Africa/Lagos|NI:America/Managua|NL:Europe/Amsterdam" +
	"|NO:Europe/Oslo|NP:Asia/Kathmandu,Asia/Katmandu|NR:Pacific/Nauru|NU:Pacific/Niue|NZ:Pacific/Auckland" +
	",Pacific/Chatham|OM:Asia/Muscat|PA:America/Panama|PE:America/Lima|PF:Pacific/Gambier,Pacific/Marques" +
	"as,Pacific/Tahiti|PG:Pacific/Bougainville,Pacific/Port_Moresby|PH:Asia/Manila|PK:Asia/Karachi|PL:Eur" +
	"ope/Warsaw|PM:America/Miquelon|PN:Pacific/Pitcairn|PR:America/Puerto_Rico|PS:Asia/Gaza,Asia/Hebron|P" +
	"T:Atlantic/Azores,Atlantic/Madeira,Europe/Lisbon|PW:Pacific/Palau|PY:America/Asuncion|QA:Asia/Qatar|" +
	"RE:Indian/Reunion|RO:Europe/Bucharest|RS:Europe/Belgrade|RU:Asia/Anadyr,Asia/Barnaul,Asia/Chita,Asia" +
	"/Irkutsk,Asia/Kamchatka,Asia/Khandyga,Asia/Krasnoyarsk,Asia/Magadan,Asia/Novokuznetsk,Asia/Novosibir" +
	"sk,Asia/Omsk,Asia/Sakhalin,Asia/Srednekolymsk,Asia/Tomsk,Asia/Ust-Nera,Asia/Vladivostok,Asia/Yakutsk" +
	",Asia/Yekaterinburg,Europe/Astrakhan,Europe/Kaliningrad,Europe/Kirov,Europe/Moscow,Europe/Samara,Eur" +
	"ope/Saratov,Europe/Ulyanovsk,Europe/Volgograd|RW:Africa/Kigali|SA:Asia/Riyadh|SB:Pacific/Guadalcanal" +
	"|SC:Indian/Mahe|SD:Africa/Khartoum|SE:Europe/Stockholm|SG:Asia/Singapore|SH:Atlantic/St_Helena|SI:Eu" +
	"rope/Ljubljana|SJ:Arctic/Longyearbyen|SK:Europe/Bratislava|SL:Africa/Freetown|SM:Europe/San_Marino|S" +
	"N:Africa/Dakar|SO:Africa/Mogadishu|SR:America/Paramaribo|SS:Africa/Juba|ST:Africa/Sao_Tome|SV:Americ" +
	"a/El_Salvador|SX:America/Lower_Princes|SY:Asia/Damascus|SZ:Africa/Mbabane|TC:America/Grand_Turk|TD:A" +
	"frica/Ndjamena|TF:Indian/Kerguelen|TG:Africa/Lome|TH:Asia/Bangkok|TJ:Asia/Dushanbe|TK:Pacific/Fakaof" +
	"o|TL:Asia/Dili|TM:Asia/Ashgabat|TN:Africa/Tunis|TO:Pacific/Tongatapu|TR:Europe/Istanbul|TT:America/P" +
	"ort_of_Spain|TV:Pacific/Funafuti|TW:Asia/Taipei|TZ:Africa/Dar_es_Salaam|UA:Europe/Kiev,Europe/Kyiv,E" +
	"urope/Simferopol|UG:Africa/Kampala|UM:Pacific/Midway,Pacific/Wake|US:America/Adak,America/Anchorage," +
	"America/Boise,America/Chicago,America/Denver,America/Detroit,America/Indiana/Indianapolis,America/In" +
	"diana/Knox,America/Indiana/Marengo,America/Indiana/Petersburg,America/Indiana/Tell_City,America/Indi" +
	"ana/Vevay,America/Indiana/Vincennes,America/Indiana/Winamac,America/Indianapolis,America/Juneau,Amer" +
	"ica/Kentucky/Louisville,America/Kentucky/Monticello,America/Los_Angeles,America/Louisville,America/M" +
	"enominee,America/Metlakatla,America/New_York,America/Nome,America/North_Dakota/Beulah,America/North_" +
	"Dakota/Center,America/North_Dakota/New_Salem,America/Phoenix,America/Sitka,America/Yakutat,Pacific/H" +
	"onolulu|UY:America/Montevideo|UZ:Asia/Samarkand,Asia/Tashkent|VA:Europe/Vatican|VC:America/St_Vincen" +
	"t|VE:America/Caracas|VG:America/Tortola|VI:America/St_Thomas|VN:Asia/Ho_Chi_Minh,Asia/Saigon|VU:Paci" +
	"fic/Efate|WF:Pacific/Wallis|WS:Pacific/Apia|YE:Asia/Aden|YT:Indian/Mayotte|ZA:Africa/Johannesburg|ZM" +
	":Africa/Lusaka|ZW:Africa/Harare";

let cache: Map<string, string> | null = null;

/** IANA zone → ISO 3166-1 alpha-2, unpacked once on first use. */
export function timezoneCountryMap(): Map<string, string> {
	if (cache) return cache;
	const map = new Map<string, string>();
	for (const group of PACKED.split("|")) {
		const colon = group.indexOf(":");
		const region = group.slice(0, colon);
		for (const zone of group.slice(colon + 1).split(",")) map.set(zone, region);
	}
	cache = map;
	return map;
}

/**
 * ISO country for an IANA zone, or `""` when it cannot be established.
 *
 * Deliberately does NOT guess. A deprecated alias (`Asia/Calcutta`, `US/Pacific`)
 * is absent from the table because no engine canonicalizes zone names for us, and
 * `UTC` belongs to no country at all — both answer empty, and an empty country is
 * simply not reported. A wrong country is worse than a missing one.
 */
export function countryForTimezone(timezone: string): string {
	return timezoneCountryMap().get(timezone) ?? "";
}

/** The zone this machine is set to, or `""` if the platform will not say. */
export function currentTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		return "";
	}
}
