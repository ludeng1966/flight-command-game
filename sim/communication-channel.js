// One tactical channel identifier for voice records and data-link reports.
// Radio/audio playback is presentation; it does not manufacture position data.
export function communicationChannel(unit){return unit?.datalink?.config?.networkId??unit?.team??unit?.faction??'blue';}
