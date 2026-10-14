/**
 * The English dictionary: the source of truth for every message key. `common`, `shortcuts` and `errors` are shared by
 * every domain; each other file holds the messages of one domain.
 */
import { common } from './common'
import { shortcuts } from './shortcuts'
import { errors } from './errors'
import { shell } from './shell'
import { mushaf } from './mushaf'
import { fonts } from './fonts'
import { furniture } from './furniture'
import { interactions } from './interactions'
import { reader } from './reader'
import { pagenav } from './pagenav'
import { player } from './player'
import { memo } from './memo'
import { navigation } from './navigation'
import { search } from './search'
import { palette } from './palette'
import { content } from './content'
import { sidepane } from './sidepane'
import { library } from './library'
import { notes } from './notes'
import { downloads } from './downloads'
import { settings } from './settings'
import { onboarding } from './onboarding'
import { about } from './about'

export const en = {
  common,
  shortcuts,
  errors,
  shell,
  mushaf,
  fonts,
  furniture,
  interactions,
  reader,
  pagenav,
  player,
  memo,
  navigation,
  search,
  palette,
  content,
  sidepane,
  library,
  notes,
  downloads,
  settings,
  onboarding,
  about,
} as const
