export enum StatusDisplayType {
  /** Display the activity name - e.g. "Listening to Spotify" */
  Name = 0,
  /** Display the state field - e.g. "Listening to Rick Astley" */
  State = 1,
  /** Display the details field - e.g. "Listening to Never Gonna Give You Up" */
  Details = 2,
}

export enum ActivityType {
  /**
   * Playing {name}
   */
  Playing = 0,
  /**
   * Streaming {name}
   */
  Streaming = 1,
  /**
   * Listening to {name}
   */
  Listening = 2,
  /**
   * Watching {name}
   */
  Watching = 3,
  /**
   * Competing in {name}
   */
  Competing = 5,
}

export enum Assets {
  Play = 'https://cdn.rcd.gg/PreMiD/resources/play.png',
  Pause = 'https://cdn.rcd.gg/PreMiD/resources/pause.png',
  Stop = 'https://cdn.rcd.gg/PreMiD/resources/stop.png',
  Repeat = 'https://cdn.rcd.gg/PreMiD/resources/repeat.png',
  RepeatOne = 'https://cdn.rcd.gg/PreMiD/resources/repeat-one.png',
}