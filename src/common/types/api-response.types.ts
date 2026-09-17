export type BaseResponse = {
  success: boolean;
  message?: string;
  requestId?: string;
};

export type BaseResponseWithData<
  T,
  RecordKey extends string = "data",
> = RecordKey extends keyof BaseResponse
  ? never
  : Omit<BaseResponse, "success"> & { success: true } & Record<RecordKey, T>;

export type ApiErrorResponse<TDetails = unknown> = Omit<BaseResponse, "success"> & {
  success: false;
  code: string;
  details?: TDetails;
};
