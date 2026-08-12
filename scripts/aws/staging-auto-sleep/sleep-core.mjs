export const schedulerUpdatePayload = (schedule, state) =>
  Object.fromEntries(
    Object.entries({
      Name: schedule.Name,
      Description: schedule.Description,
      ScheduleExpression: schedule.ScheduleExpression,
      ScheduleExpressionTimezone: schedule.ScheduleExpressionTimezone,
      FlexibleTimeWindow: schedule.FlexibleTimeWindow,
      Target: schedule.Target,
      State: state,
      StartDate: schedule.StartDate,
      EndDate: schedule.EndDate,
      KmsKeyArn: schedule.KmsKeyArn,
      GroupName: schedule.GroupName,
      ActionAfterCompletion: schedule.ActionAfterCompletion,
    }).filter(([, value]) => value !== undefined && value !== null),
  );
