---
layout: post
title: ! 'Avoiding duplicate records with AWS KCL and S3: Exactly once record processing of Kinesis Data Streams (1/2)'
date: 2020-01-29 20:00:00 -0000
---

If you have managed to find this article, it is fair to assume that you are trying to decide a strategy to avoid processing duplicate records from Kinesis Data Streams using KCL and have a fair understanding of how KCL works. In this post, I will explain how we can implement a design, which will allow us to achieve "Exactly once" kinesis record processing and hence avoid duplicates.

## When can you expect duplicate records ?
Kinesis consumers have a concept of a `checkpoint` which is stored in a database (DynamoDB in the case of KCL). You start with TRIM_HORIZON but as you process records, you keep updating the checkpoint with the Sequence number untill which you have processed your records. The KCL provides with helper functions to easily do checkpointing. Ideally, you would do checkpointing periodically within a certain interval. If checkpointing fails due to any reasons, your consumer application will recieve the same records again when it subscribes to that kinesis shard the next time. Here are scenarios where checkpointing may fail. 
- Your application crashes in the middle of the processing records and before checkpointing successfully. In our case, we were checkpointing at 30 seconds interval, which meant, a single failure to checkpoint, due to an app crash, will result in about 50,000 duplicate records during peak hour.
- The DynamoDb table used by the KCL to store checkpoints gets deleted or its items are deleted. In this case all the events, available in the kinesis data stream would be reprocessed.
- Any other reason that can cause checkpointing to fail, like, temporary network issues, DynamoDb throttling, followed by a non graceful consumer app shutdown.

## Solution
The solution provided by Amazon for [Being Resilient to Consumer Retries](https://docs.aws.amazon.com/streams/latest/dev/kinesis-record-processor-duplicates.html) is not really resilient enough. The very first thing that the given approach fails to handle is the fact that the batch size of the records received by the worker is not fixed. 

The solution we implemented makes sure that the records are processed exactly once. The idea is to store events by grouping them based on the minute they were received by the Kinesis data stream by looking at their `ApproximateArrivalTimestamp`. This allows us to always save our events on the same key prefix, given a batch of records no matter when they are processed. 
For e.g. all events received by Kinesis at 2020/02/02/ 15:55 Hrs will be stored at `<some-static-prefix>/2020/02/02/15/55/*`.
Therefore, if the key is already present in the given minute, it means that the batch has already been processed and stored to S3.

We wrote our consumer app using the KCL for .NET and this is how the `ProcessRecords` implementation looks like. We will get into detail of whats going on line by line.

 
```csharp
public void ProcessRecords(ProcessRecordsInput input)
{
    _logger.LogInformation(input.Records.Count + " events recieved for processing");

    // Deduplicate records if needed, process and perform all exception handling.
    DeduplicateRecords(input.Records, ProcessAndSaveToS3);
    
    // Checkpoint once every checkpoint interval.
    if (DateTime.UtcNow >= _nextCheckpointTime)
    {
        Checkpoint(input.Checkpointer);
        _nextCheckpointTime = DateTime.UtcNow + CheckpointInterval;
    }
}

void DeduplicateRecords(IEnumerable<Record> allRecords, Action<string, IEnumerable<Record>> postDeduplicationAction)
{
    foreach (var group in allRecords.GroupByMinutes())
    {
        var groupCount = group.Count();
        _logger.LogInformation($"Processing batch with size {groupCount} with timestamp {group.Key}");
        var orderedRecords = group.OrderBy(x => x.ApproximateArrivalTimestamp);
        var nonDuplicateRecords = orderedRecords.AsEnumerable();
        var sequenceRange = new SequenceRange(orderedRecords.First().SequenceNumber, orderedRecords.Last().SequenceNumber);
        var s3EventBatchKey = new S3EventBatchKey(_staticPrefix, dateTime, sequenceRange);
        if (_deduplicator.IsEnabled())
        {
            var sequenceStore = new S3SequenceStore(_amazonS3, _bucketName, s3EventBatchKey);
            _deduplicator.Deduplicate(sequenceRange, sequenceStore).Wait();
            if (sequenceRange.AnyExluded)
            {
                nonDuplicateRecords = orderedRecords.Where(r => sequenceRange.Contains(r.SequenceNumber));
                _logger.LogInformation("Duplicates found: " + (groupCount - nonDuplicateRecords.Count()));
            }
            else
            {
                // this means there is no more deduplication for this worker. We can stop checking for duplicate records now.
                _deduplicator.DisableDeduplication();
                _logger.LogInformation("Deduplication disabled.");
            }
        }
        postDeduplicationAction(s3EventBatchKey.ToString(), nonDuplicateRecords);
    }
}

void ProcessAndSaveToS3(string batchKey, IEnumerable<Records> records)
{
    _s3Store.Save(batchKey, System.Text.Json.JsonSerializer.Serialize(records));
}
```
The second function `DeduplicateRecords` is where most of the heavy lifting is happening. 
1. In the first line of the dfunction,

`foreach (var group in allRecords.GroupByMinutes())`

We start by grouping all events by the minute of `ApproximateArrivalTimestamp` for each record.
This is how the `GroupByMinutes` exension method looks like

```csharp
public static ILookup<DateTime, Record> GroupByMinutes(this IEnumerable<Record> records)
{
    return records.ToLookup(x =>
    {
        var dt = DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(x.ApproximateArrivalTimestamp)).UtcDateTime;
        return new DateTime(dt.Year, dt.Month, dt.Day, dt.Hour, dt.Minute, 0, DateTimeKind.Utc);
    });
}
```
As you can see the grouping strips out the seconds part of the `DateTime` and groups by the minute when the records where received by Kinesis.

2. The next significant line is 

`var sequenceRange = new SequenceRange(orderedRecords.First().SequenceNumber, orderedRecords.Last().SequenceNumber);`

This creates an instance of `SequenceRange`, which is a data structure to operate on sequence number ranges of a given batch of kinesis records. 
This is what the class looks like
```csharp
    /// <summary>
    /// Data Structure to work with Sequence numbers. e.g. 90000000000000000000000098-91122343454565676789789098
    /// Ideal for large sequence numbers. Tries to work with large sequence numbers in a memory efficient manner.
    /// Basically tries to avoid looping over every sequence number, because <see cref="BigInteger"/> dont have any limits.
    /// </summary>
    public class SequenceRange : IComparable<SequenceRange>
    {
        /// <summary>
        /// Can hold a string value or a stringified <see cref="SequenceRange"/>
        /// </summary>
        private readonly HashSet<string> _excludeList;
        public const char FormatDelimiter = '-';
        /// <summary>
        /// string values must be parsable to <see cref="BigInteger"/>
        /// </summary>
        /// <param name="startingSeqNum"></param>
        /// <param name="endingSeqNum"></param>
        static SequenceRange()
        {
            Empty = new SequenceRange(0, 0);
        }

        public SequenceRange(string startingSeqNum, string endingSeqNum) : this(BigInteger.Parse(startingSeqNum), BigInteger.Parse(endingSeqNum))
        { }
        
        public SequenceRange(BigInteger startingSeqNum, BigInteger endingSeqNum)
        {
            if (startingSeqNum > endingSeqNum)
                throw new ArgumentOutOfRangeException(nameof(endingSeqNum) + " cannot be greater than " + nameof(startingSeqNum));

            StartingSeqNum = startingSeqNum;
            EndingSeqNum = endingSeqNum;
            _excludeList = new HashSet<string>();
        }

        /// <summary>
        /// Starting sequqnce number stored as a <see cref="BigInteger"/>
        /// </summary>
        /// <summary>
        public BigInteger StartingSeqNum { get; private set; }
        
        /// <summary>
        /// Ending sequqnce number stored as a <see cref="BigInteger"/>
        /// </summary>
        public BigInteger EndingSeqNum { get; private set; }
        
        /// <summary>
        /// Add a sequence number to the exclude list
        /// </summary>
        /// <param name="seqNum"></param>
        public void Exclude(string seqNum)
        {
            _excludeList.Add(seqNum);
        }
        
        /// <summary>
        /// Add a sequence range to the exclude list
        /// </summary>
        /// <param name="seqRange"></param>
        public void Exclude(SequenceRange seqRange)
        {
            _excludeList.Add(seqRange.ToString());
        }

        /// <summary>
        /// Excludes the current instance's sequences range
        /// </summary>
        public void ExcludeAll()
        {
            Exclude(this);
        }

        /// <summary>
        /// Exclude list in comma separated string
        /// </summary>
        public string ExcludeList => string.Join(',', _excludeList);

        /// <summary>
        /// Return true if there is any item on the exclude list.
        /// </summary>
        public bool AnyExluded => _excludeList.Count > 0;
        
        /// This will check if the given value is present within in the sequence range, also taking into account the exclude list.
        /// </summary>
        /// <param name="seqNum"></param>
        /// <returns></returns>
        public bool Contains(string seqNum)
        {
            return Contains(BigInteger.Parse(seqNum));
        }

        /// <summary>
        /// This will check if the given value is present within the sequence range, also taking into account the exclude list.
        /// </summary>
        /// <param name="seqNum"></param>
        /// <returns></returns>
        public bool Contains(BigInteger seqNum)
        {
            // check exclude list first
            foreach (var excludedItem in _excludeList)
            {
                if (TryParse(excludedItem, out var sr))
                {
                    //fresh instance of sequence range, which means no exclude list
                    if (sr.Contains(seqNum))
                        return false;
                }
                else
                {
                    // this means parsing failed which means it must be a string
                    if (BigInteger.Parse(excludedItem).Equals(seqNum))
                        return false;
                }
            }
            return seqNum >= StartingSeqNum && seqNum <= EndingSeqNum;
        }

        /// <summary>
        /// Check if two <see cref="SequenceRange"/> values overlap
        /// </summary>
        /// <param name="other"></param>
        /// <returns></returns>
        public bool OverLaps(SequenceRange other)
        {
            if (other.StartingSeqNum >= StartingSeqNum)
                return other.StartingSeqNum <= EndingSeqNum;
            else
                return other.EndingSeqNum >= StartingSeqNum;
        }

        /// <summary>
        /// Stringifies to StartingSequenceNumber-EndingSequenceNumber format
        /// </summary>
        /// <returns></returns>
        public override string ToString()
        {
            return $"{StartingSeqNum}{FormatDelimiter}{EndingSeqNum}";
        }

        /// <summary>
        /// Parse a StartingSequenceNumber-EndingSequenceNumber format to a <see cref="SequenceRange"/> instance
        /// </summary>
        /// <param name="seqStr"></param>
        /// <returns></returns>
        /// <exception cref="ArgumentException">Thrown when string cannot be parsed</exception>
        public static SequenceRange Parse(string seqStr)
        {
            if (TryParse(seqStr, out var sr))
                return sr;
            throw new ArgumentException("Could not parse sequence range");
        }

        /// <summary>
        /// Tries to parse a StartingSequenceNumber-EndingSequenceNumber format to a <see cref="SequenceRange"/> instance
        /// </summary>
        /// <param name="seqStr"></param>
        /// <returns></returns>
        /// <exception cref="ArgumentException">Thrown when string cannot be parsed</exception>
        public static bool TryParse(string seqStr, [NotNullWhen(returnValue: true)] out SequenceRange? seqRange)
        {
            var tokens = seqStr.Split(FormatDelimiter);
            if (tokens.Length == 2 && BigInteger.TryParse(tokens[0], out var _) && BigInteger.TryParse(tokens[1], out var _))
            {
                seqRange = new SequenceRange(tokens[0], tokens[1]);
                return true;
            };
            seqRange = null;
            return false;
        }

        /// <summary>
        /// <see cref="IComparable{SequenceRange}"/> implementation
        /// </summary>
        /// <param name="other"></param>
        /// <returns></returns>
        public int CompareTo([AllowNull] SequenceRange other)
        {
            if (other is null)
                return 1;
            else if (StartingSeqNum == other.StartingSeqNum && EndingSeqNum == other.EndingSeqNum)
                return 0;
            else if (StartingSeqNum > other.EndingSeqNum)
                return 1;
            else if (EndingSeqNum < other.StartingSeqNum)
                return -1;
            else
            {
                //overlapping
                if (StartingSeqNum > other.StartingSeqNum)
                    return 2;
                else
                    return -2;
            }
        }

        public static bool operator >(SequenceRange a, SequenceRange b)
        {
            return a.CompareTo(b) == 1;
        }

        public static bool operator <(SequenceRange a, SequenceRange b)
        {
            return a.CompareTo(b) == -1;
        }

        public static bool operator ==(SequenceRange a, SequenceRange b)
        {
            return a.CompareTo(b) == 0;
        }

        public static bool operator !=(SequenceRange a, SequenceRange b)
        {
            return a.CompareTo(b) != 0;
        }

        public override bool Equals(object obj)
        {
            if (ReferenceEquals(this, obj))
            {
                return true;
            }

            if (ReferenceEquals(obj, null))
            {
                return false;
            }

            var seqRange = obj as SequenceRange;
            if (seqRange is null)
                return false;

            return CompareTo(seqRange) == 0;
        }

        public override int GetHashCode()
        {
            return ToString().GetHashCode();
        }

        public static SequenceRange Empty { get; private set; }
    }
```

3. In the next line,

`var s3EventBatchKey = new S3EventBatchKey(_staticPrefix, dateTime, sequenceRange);`

we create an instance of `S3EventBatchKey` which represents the s3 key that will be used to save this batch of events. The class has the following structure
```csharp
public class S3EventBatchKey
{
    private readonly DateTime _dateTime;
    private readonly SequenceRange _sequenceRange;

    public S3EventBatchKey(string staticPrefix, DateTime dateTime, SequenceRange sequenceRange)
    {
        _dateTime = dateTime;
        _sequenceRange = sequenceRange;
        Prefix = staticPrefix + dateTime.ToString(Constants.S3DateFormat) + "/";
    }

    public string Prefix { get; private set; }
    
    /// <summary>
    /// Timestamp, but reveresed
    /// </summary>
    public string ReverseSorter => (long.MaxValue - new DateTimeOffset(_dateTime).ToUnixTimeMilliseconds()).ToString().PadLeft(long.MaxValue.ToString().Length, '0') + "-";
    
    public override string ToString()
    {
        if (string.IsNullOrWhiteSpace(Prefix))
            return _sequenceRange.ToString();
        else
            return Prefix + SortKey;
    }
    
    /// <summary>
    /// By default,S3 keys are basically ordereded ASC, this helps us to order them DESC, which lists the latest batch first within the <see cref="Prefix"/>
    /// </summary>
    public string SortKey => ReverseSorter + _sequenceRange;

    public SequenceRange ParseSequenceRangeFromKey(string fullKey)
    {
        var key = fullKey;
        if (fullKey.Contains(Prefix))
            key = fullKey.Remove(0, Prefix.Length);
        //remove any file extensions if any
        key = key.Split(".").First();

        var sortKeyTokens = key.Split("-");
        if (sortKeyTokens.Length < 2)
            throw new ArgumentException("Sort key tokens must be at least two.");
        var seqNumsTokens = sortKeyTokens.TakeLast(2);
        return new SequenceRange(seqNumsTokens.First(), seqNumsTokens.Last());
    }
}
```

4. Next, we introduce the `IDeduplicator`, stored as a field value `_deduplicator`. It is initialized (or injected) at the constructor of the `Processor`. It looks like

```csharp
public interface IDeduplicator
{
    void EnableDeduplication();
    void DisableDeduplication();
    bool IsEnabled();
    Task Deduplicate(SequenceRange sequenceRange, ISequenceStore _sequenceStore);
}
```
and the implementation is

```csharp
public class Deduplicator : IDeduplicator
{
    private bool _enabled;

    public Deduplicator(bool enabled = true)
    {
        _enabled = enabled;
    }

    /// <summary>
    /// Mutates the provided <see cref="SequenceRange"/> and removes the duplicates
    /// </summary>
    /// <param name="newSequenceRange"></param>
    /// <returns></returns>
    public async Task Deduplicate(SequenceRange newSequenceRange, ISequenceStore sequenceStore)
    {
        if (!_enabled)
            return;

        var index = 0;
        while (await Deduplicate(newSequenceRange, sequenceStore, index))
            index++;

    }

    public void DisableDeduplication()
    {
        _enabled = false;
    }

    public void EnableDeduplication()
    {
        _enabled = true;
    }

    public bool IsEnabled()
    {
        return _enabled;
    }

    /// <summary>
    /// Returns true as long as the new sequence range not more than the last stored sequences ranges
    /// </summary>
    /// <param name="newSequenceRange"></param>
    /// <param name="index"></param>
    /// <returns></returns>
    private async Task<bool> Deduplicate(SequenceRange newSequenceRange, ISequenceStore sequenceStore, int index)
    {
        var lastSequenceRanges = await sequenceStore.GetLastSequenceRanges(index).ConfigureAwait(false);
        if (lastSequenceRanges is null || lastSequenceRanges.Count() == 0)
            return false;
        foreach (var lastSequenceRange in lastSequenceRanges)
        {
            if (newSequenceRange > lastSequenceRange) //no duplication
                return false;

            else if (newSequenceRange < lastSequenceRange)
                newSequenceRange.ExcludeAll();

            //neither less or greater than, means must overlap
            else if (newSequenceRange.OverLaps(lastSequenceRange))
                newSequenceRange.Exclude(lastSequenceRange);

            else
                throw new Exception($"This cannot happen. " +
                    $"{nameof(lastSequenceRange)} {lastSequenceRange} is neither greater than, nor smaller than, nor overlapping {nameof(newSequenceRange)} {newSequenceRange}" +
                    $" This means there is a bug in this library's code. Don't blame yourself. Raise an issue.");
        }
        return true;

    }
}
```
5. The final piece of the puzzle is the `ISequenceStore` implementation, 
```csharp
public class S3SequenceStore : ISequenceStore
{
    private readonly IAmazonS3 _amazonS3;
    private readonly string _bucketName;
    private readonly S3EventBatchKey _s3EventKey;
    private readonly List<string> _nextContinuationTokens;

    public S3SequenceStore(IAmazonS3 amazonS3, string bucketName, S3EventBatchKey s3EventKey)
    {
        _amazonS3 = amazonS3;
        _bucketName = bucketName;
        _s3EventKey = s3EventKey;
        _nextContinuationTokens = new List<string>();
    }
    public async Task<IEnumerable<SequenceRange>> GetLastSequenceRanges(int index)
    {
        if (_nextContinuationTokens.Count < index)
            return Enumerable.Empty<SequenceRange>();

        var s3Files = await _amazonS3.ListObjectsV2Async(new ListObjectsV2Request()
        {
            BucketName = _bucketName,
            ContinuationToken = index == 0 ? null : _nextContinuationTokens[index - 1],
            Prefix = _s3EventKey.Prefix
        });

        if (!string.IsNullOrWhiteSpace(s3Files.NextContinuationToken))
            _nextContinuationTokens.Add(s3Files.NextContinuationToken);

        return s3Files.S3Objects.Select(x => _s3EventKey.ParseSequenceRangeFromKey(x.Key));
    }
}
```
`GetLastSequenceRanges` lists the all the keys with a given prefix, in our case it will be all the events for that minute, if there are no objects saved for that minute it means it is a fresh batch of events. This method will be called multiple time, with incrementing `index` by `IDeduplicaor` untill it returns an empty list of `SequenceRange`.

6. The `SequenceRange` class helps us to filter out all records that have already been processed within this batch and then save the remaining under a new key.
7. Also it is important to disable deduplication once there are no more duplicate records found using `_deduplicator.DisableDeduplication();`.  This means that the records are fresh and no more deduplication needs to be done. When the consumer app starts, deduplication needs to be enabled by default to check if the app crashed unexpectedly the last time leaving duplicate records to be processed.

## Summary
In summary, we introduced a way to filter out duplicate record using the class `SequenceRange` and by storing record batches in such a way that their keys are alway determinstic. We did this every time app starts, to make sure if in case any checkpoiting failed during the last app shutdown. ~~I know I could have simply pacakged all this into a library and given you a one liner usage, but whats the fun in that ?~~ Actually scratch that, I will be making a part 2 of this where I will package all this into a Nuget library and provide a easier usage to do the same thing.
