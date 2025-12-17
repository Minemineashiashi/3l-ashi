import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Vpc, IpAddresses, SubnetType, SecurityGroup, Peer ,Port, InstanceType, InstanceClass, InstanceSize, InterfaceVpcEndpointAwsService} from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer, ApplicationTargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { FargateTaskDefinition, ContainerImage, LogDriver, Cluster, FargateService, Protocol, Secret, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'; 
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subsc from 'aws-cdk-lib/aws-sns-subscriptions'
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';


export class ThreeLayerStackAshimine extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================================
    // Network
    // ========================================================
    const vpc = new Vpc(this, 'VpcAshimine',{
      ipAddresses: IpAddresses.cidr('10.100.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask:24,
          name: 'Public',
          subnetType: SubnetType.PUBLIC,       
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask:24,
          name: 'Private_DB',
          subnetType: SubnetType.PRIVATE_ISOLATED
        }
      ]
    });
    const securityGroupForAlb = new SecurityGroup(this, 'SgAlbAshimine',{
      vpc: vpc,
      allowAllOutbound: false,
    });
    securityGroupForAlb.addIngressRule(Peer.ipv4('153.127.216.82/32'), Port.tcp(80));
    // 証明書作成後は次に変更
    // securityGroupForAlb.addIngressRule(Peer.anyIpv4), Port.tcp(443);
    securityGroupForAlb.addEgressRule(Peer.anyIpv4(), Port.allTcp());
    const securityGroupForFargate = new SecurityGroup(this, 'SgFargateAshimine',{
      vpc: vpc,
      allowAllOutbound: false,
    });
    securityGroupForFargate.addIngressRule(securityGroupForAlb, Port.tcp(80));
    securityGroupForFargate.addEgressRule(Peer.anyIpv4(), Port.allTcp());
    const securityGroupForEfs = new SecurityGroup(this, 'SgEfsAshimine', {
      vpc: vpc,
      allowAllOutbound: false,
    });
    securityGroupForEfs.addIngressRule(securityGroupForFargate, Port.allTcp());
    securityGroupForEfs.addEgressRule(Peer.anyIpv4(), Port.allTcp());
    const albForApp = new ApplicationLoadBalancer(this, 'AlbAshimine', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: securityGroupForAlb,
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Public',
      }),
    });
    // ========================================================
    // Database
    // ========================================================
    const rdsInstance = new rds.DatabaseInstance(this, 'RdsAshimine', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_39 }),
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Private_DB',
      }),
      databaseName: 'dbname',
    }); // credentials プロパティを指定しない場合、CDKが自動でusername/password/host等を含むシークレットを作成
    rdsInstance.connections.allowFrom(
      securityGroupForFargate,
      Port.tcp(3306),
      'Allow Fargate to connect to RDS'
    )
    // ========================================================
    // Authority
    // ========================================================
    const executionRole = new Role(this, 'EcsTaskExecutionRoleAshimine', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    const databaseSecret = rdsInstance.secret!;
    databaseSecret.grantRead(executionRole);
    const serviceTaskRole = new Role(this, 'ECSServiceTaskRoleAshimine', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies:[
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMFullAccess'),
      ]
    });
    // ========================================================
    // File system
    // ========================================================
    const fileSystem = new efs.FileSystem(this, 'FileSystemAshimine', {
      vpc: vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_1_DAY,
      securityGroup: securityGroupForEfs,
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Private',
      }),
    });
    fileSystem.grantReadWrite(serviceTaskRole);
    //タスク実行ロールにはEFSアクション権限不要
    const accessPoint = fileSystem.addAccessPoint('EFSAccessPoint', {
      path: '/app',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '750',
      },
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
    });
    vpc.addInterfaceEndpoint('EfsEndPointAshimine', {
      service: InterfaceVpcEndpointAwsService.ELASTIC_FILESYSTEM
    })
    // ========================================================
    // Container , ECS
    // ========================================================
    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinitionAshimine', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: executionRole,
      taskRole: serviceTaskRole,
      volumes: [
        {
          name: 'Efs', // TODO: container.addMountPointsメソッドにてこのnameを参照するため、変数にして両方に設定したい。
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
              iam: 'ENABLED'
            },
          },
        }
      ]
    });
    const ecrReposiroty = ecr.Repository.fromRepositoryName(
      this,
      'repositoryReference',
      'ashimine/threelayer'
    );
    const container = taskDefinition.addContainer('ashimine', {
      image: ContainerImage.fromEcrRepository(
        ecrReposiroty,
        'v1.1'
      ),
      logging: LogDriver.awsLogs({
        streamPrefix: `Ashimine`,
      }),
      secrets: { // コンテナイメージ側が要求する環境変数 https://hub.docker.com/_/wordpress
        WORDPRESS_DB_USER: Secret.fromSecretsManager(databaseSecret, 'username'),
        WORDPRESS_DB_PASSWORD: Secret.fromSecretsManager(databaseSecret, 'password'),
        WORDPRESS_DB_HOST: Secret.fromSecretsManager(databaseSecret, 'host'),
        WORDPRESS_DB_NAME: Secret.fromSecretsManager(databaseSecret, 'dbname'),
      }
    });
    container.addPortMappings({
      containerPort: 80,
      hostPort:80,
      protocol: Protocol.TCP,
    });
    container.addMountPoints({
      sourceVolume: 'Efs',
      containerPath: '/app',
      readOnly: false,
    });
    const cluster = new Cluster(this, 'ClusterAshimine', {
      vpc: vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
    });
    const fargateService = new FargateService(this, 'FargateServiceAshimine', {
      cluster,
      vpcSubnets: vpc.selectSubnets({ subnetGroupName: 'Private' }),
      securityGroups: [securityGroupForFargate],
      taskDefinition: taskDefinition,
      desiredCount: 2,
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      enableExecuteCommand: true,
    });
    const targetGroup = new ApplicationTargetGroup(this, 'TargetGroupAshimine', {
      port: 80,
      vpc: vpc,
      //  FargateでECSタスクを実行する場青、ネットワークモードが'awsvpc'になり、ALB側でも明示的にTargetTypeをIPに設定しなければならない。https://docs.aws.amazon.com/ja_jp/AmazonECS/latest/developerguide/AWS_Fargate.html#fargate-tasks-services-load-balancing
      targetType: TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 10,
        healthyHttpCodes: '200,302',
      }
    });
    fargateService.attachToApplicationTargetGroup(targetGroup);
    const albListener = albForApp.addListener('AlbListnerAshimine', {
      port: 80,
      defaultTargetGroups: [targetGroup]
    });
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: albForApp.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, 'ClusterName',{
      value: cluster.clusterName
    })
    new cdk.CfnOutput(this, 'ContainerName',{
      value: container.containerName
    });
    const autoScale = fargateService.autoScaleTaskCount({
      minCapacity:2,
      maxCapacity:4
    });
    autoScale.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 20,
    });
    autoScale.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 20,
    })
    // ========================================================
    // Monitoring
    // ========================================================
    const topic = new sns.Topic(this, 'Topic');
    topic.addSubscription(new subsc.EmailSubscription('ashimine.daichi@cloudcentric.co.jp'))
    const cpuMetric =  fargateService.metricCpuUtilization();
    const memoryMetric = fargateService.metricMemoryUtilization();
    const alarmCpu = new cloudwatch.Alarm(this, 'AlarmCpu', {
      metric: cpuMetric,
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 3
    })
    alarmCpu.addAlarmAction(new actions.SnsAction(topic));
    const alarmMemory = new cloudwatch.Alarm(this, 'AlarmMemory', {
      metric: memoryMetric,
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 3
    })
    alarmMemory.addAlarmAction(new actions.SnsAction(topic));
  }
};
