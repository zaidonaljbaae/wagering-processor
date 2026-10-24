import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';

export interface ReceiveOptions {
  maxMessages: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface OutgoingMessage {
  body: string;
  groupId: string;
  deduplicationId: string;
  attributes?: Record<string, string>;
}

/** Thin wrapper over the SQS client: queue URL resolution and the calls we use. */
@Injectable()
export class SqsGateway implements OnApplicationShutdown {
  readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new SQSClient({
      region: config.sqs.region,
      ...(config.sqs.endpoint && { endpoint: config.sqs.endpoint }),
      maxAttempts: 3,
    });
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => r.QueueUrl!);
      url.catch(() => this.urls.delete(name)); // don't cache failures
      this.urls.set(name, url);
    }
    return url;
  }

  async send(queueName: string, message: OutgoingMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
        ...(message.attributes && { MessageAttributes: stringAttributes(message.attributes) }),
      }),
    );
  }

  async receive(queueName: string, options: ReceiveOptions, signal?: AbortSignal): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    return result.Messages ?? [];
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queueName), ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(queueName: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.min(43_200, Math.round(seconds))),
      }),
    );
  }

  /** Readiness probe: the queue exists and SQS answers. */
  async ping(queueName: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(queueName), AttributeNames: ['QueueArn'] }),
    );
  }

  /**
   * Creates the FIFO queues with the DLQ redrive policy. Meant for local and
   * test environments; production queues belong to infrastructure-as-code.
   * The redrive threshold is one above the app's own limit, so the app
   * normally dead-letters explicitly (with a reason) and SQS is the safety net.
   */
  async ensureQueues(): Promise<void> {
    const { wagerQueue, wagerDlq, eventsQueue } = this.config.sqs;
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

    const dlq = await this.client.send(
      new CreateQueueCommand({ QueueName: wagerDlq, Attributes: { ...fifo, MessageRetentionPeriod: '1209600' } }),
    );
    const dlqArn = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn'] }),
    );
    await this.client.send(
      new CreateQueueCommand({
        QueueName: wagerQueue,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(this.config.consumer.visibilityTimeoutSeconds),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn.Attributes!.QueueArn,
            maxReceiveCount: String(this.config.consumer.maxAttempts + 1),
          }),
        },
      }),
    );
    await this.client.send(new CreateQueueCommand({ QueueName: eventsQueue, Attributes: fifo }));
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

function stringAttributes(attributes: Record<string, string>): Record<string, MessageAttributeValue> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key, { DataType: 'String', StringValue: value }]),
  );
}
