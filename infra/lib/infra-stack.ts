import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DYNAMODB TABLES ──────────────────────────────────────────────────────

    const runsTable = new dynamodb.Table(this, 'RunsTable', {
      tableName: 'tripai-runs',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    runsTable.addGlobalSecondaryIndex({
      indexName: 'status-created-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });

    const agentCallsTable = new dynamodb.Table(this, 'AgentCallsTable', {
      tableName: 'tripai-agent-calls',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    agentCallsTable.addGlobalSecondaryIndex({
      indexName: 'run-id-index',
      partitionKey: { name: 'run_id', type: dynamodb.AttributeType.STRING },
    });

    const toolCallsTable = new dynamodb.Table(this, 'ToolCallsTable', {
      tableName: 'tripai-tool-calls',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    toolCallsTable.addGlobalSecondaryIndex({
      indexName: 'run-id-index',
      partitionKey: { name: 'run_id', type: dynamodb.AttributeType.STRING },
    });

    // ── IAM ROLE FOR EC2 ─────────────────────────────────────────────────────
    // Allows the instance to access DynamoDB and SSM (for parameter/secret fetch)
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    [runsTable, agentCallsTable, toolCallsTable].forEach(t =>
      t.grantReadWriteData(instanceRole)
    );

    // ── VPC / SECURITY GROUP ─────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });

    const sg = new ec2.SecurityGroup(this, 'BackendSG', {
      vpc,
      description: 'TripAI backend',
      allowAllOutbound: true,
    });
    // SSH (restrict to your IP in production)
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    // FastAPI
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8000), 'FastAPI');

    // ── EC2 t2.micro ─────────────────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf update -y --allowerasing',
      'dnf install -y git curl unzip nodejs npm --allowerasing',
      'dnf install -y alsa-lib atk at-spi2-atk at-spi2-core cairo cups-libs dbus-libs expat flac-libs gdk-pixbuf2 glib2 gtk3 libdrm libgbm libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxkbcommon mesa-libGL nspr nss nss-util pango xdg-utils',

      'curl -LsSf https://astral.sh/uv/install.sh | sh',
      'export PATH="/root/.local/bin:$PATH"',

      'cd /home/ec2-user',
      'git clone https://github.com/arpan65/Claude-Agentic-Workflow.git app',
      'chown -R ec2-user:ec2-user app',
      'cd app',

      '/root/.local/bin/uv sync --frozen',
      '/root/.local/bin/uv run playwright install chromium',

      'cat > /etc/systemd/system/tripai.service << EOF',
      '[Unit]',
      'Description=TripAI FastAPI backend',
      'After=network.target',
      '',
      '[Service]',
      'User=root',
      'WorkingDirectory=/home/ec2-user/app',
      'EnvironmentFile=/home/ec2-user/app/.env',
      'Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'ExecStart=/root/.local/bin/uv run uvicorn app.api:app --host 0.0.0.0 --port 8000 --log-level info',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'EOF',
      'systemctl daemon-reload',
      'systemctl enable tripai',
    );

    const instance = new ec2.Instance(this, 'BackendInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role: instanceRole,
      userData,
      keyName: 'tripai-key',
    });

    // ── S3 BUCKET (frontend static files) ────────────────────────────────────
    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── CLOUDFRONT DISTRIBUTION ───────────────────────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC');

    const ec2Origin = new origins.HttpOrigin(instance.instancePublicDnsName, {
      httpPort: 8000,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    const distribution = new cloudfront.Distribution(this, 'CDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: ec2Origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        '/health': {
          origin: ec2Origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // ── OUTPUTS ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'InstancePublicIP', {
      value: instance.instancePublicIp,
      description: 'EC2 public IP — backend runs on port 8000',
    });
    new cdk.CfnOutput(this, 'InstancePublicDNS', {
      value: instance.instancePublicDnsName,
      description: 'EC2 public DNS',
    });
    new cdk.CfnOutput(this, 'BackendURL', {
      value: `http://${instance.instancePublicIp}:8000`,
      description: 'FastAPI base URL',
    });
    new cdk.CfnOutput(this, 'RunsTableName', { value: runsTable.tableName });
    new cdk.CfnOutput(this, 'AgentCallsTableName', { value: agentCallsTable.tableName });
    new cdk.CfnOutput(this, 'ToolCallsTableName', { value: toolCallsTable.tableName });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Frontend URL',
    });
  }
}
