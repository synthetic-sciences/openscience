import type { OpenScienceClient } from "../src/v2/client.js"
import type {
  SettingsReviewGetData,
  SettingsReviewGetResponse,
  SettingsReviewGetResponses,
  SettingsReviewSetData,
  SettingsReviewSetResponse,
  SettingsReviewSetResponses,
} from "../src/v2/gen/types.gen.js"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Field<T, K extends PropertyKey> = K extends keyof NonNullable<T> ? true : false

type Review = OpenScienceClient["settings"]["review"]
type _reviewGet = Assert<Field<Review, "get">>
type _reviewSet = Assert<Field<Review, "set">>
type _getData = Assert<Equal<SettingsReviewGetData["url"], "/settings/review">>
type _getResponses = Assert<Equal<keyof SettingsReviewGetResponses, 200>>
type _getResponse = Assert<Equal<SettingsReviewGetResponse, SettingsReviewGetResponses[200]>>
type _setData = Assert<Equal<SettingsReviewSetData["url"], "/settings/review">>
type _setResponses = Assert<Equal<keyof SettingsReviewSetResponses, 200>>
type _setResponse = Assert<Equal<SettingsReviewSetResponse, SettingsReviewSetResponses[200]>>

export const reviewContract = {
  get: true as _reviewGet,
  set: true as _reviewSet,
  getData: true as _getData,
  getResponses: true as _getResponses,
  getResponse: true as _getResponse,
  setData: true as _setData,
  setResponses: true as _setResponses,
  setResponse: true as _setResponse,
} as const
