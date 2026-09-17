export type BaseResponse = {
  success: boolean;
  message?: string;
  requestId?: string;
};

export type BaseResponseWithData<
  T,
  RecordKey extends string = 'data',
> = RecordKey extends keyof BaseResponse
  ? never
  : BaseResponse & {
    success: true
} & Record<RecordKey, T>;

export type ApiErrorResponse<TDetails = unknown> = BaseResponse & {
  success: false;
  code: string;
  details?: TDetails;
};
