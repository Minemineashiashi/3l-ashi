import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Vpc, IpAddresses, SubnetType, SecurityGroup, Peer ,Port, InstanceType, InstanceClass, InstanceSize } from 'aws-cdk-lib/aws-ec2';
import { ApplicationLoadBalancer} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { FargateTaskDefinition, ContainerImage, LogDriver, Cluster, FargateService, Protocol, Secret, ContainerInsights } from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

export class ThreeLayerStackAshimine extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    const SecurityGroupForFargate = new SecurityGroup(this, 'SgFargateAshimine',{
      vpc: vpc,
      allowAllOutbound: false,
    });
    SecurityGroupForFargate.addIngressRule(securityGroupForAlb,Port.tcp(80));
    SecurityGroupForFargate.addEgressRule(Peer.anyIpv4(), Port.allTcp());

    const albForApp = new ApplicationLoadBalancer(this, 'AlbAshimine', {
      vpc: vpc,
      internetFacing: true,
      securityGroup: securityGroupForAlb,
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Public',
      }),
    })

    const rdsInstance = new rds.DatabaseInstance(this, 'RdsAshimine', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_39 }),
      vpc,
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpcSubnets: vpc.selectSubnets({
        subnetGroupName: 'Private_DB',
      }),
      databaseName: 'dbname',
    }) // credentials プロパティを指定しない場合、CDKが自動でusername/password/host等を含むシークレットを作成

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

    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinitionAshimine', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: executionRole,
      taskRole: serviceTaskRole,
    });

    taskDefinition.addContainer('ashimine', {
      image: ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      logging: LogDriver.awsLogs({
        streamPrefix: `Ashimine`,
      }),
      secrets: {
        DB_USERNAME: Secret.fromSecretsManager(databaseSecret, 'username'),
        DB_PASSWORD: Secret.fromSecretsManager(databaseSecret, 'password'),
        DB_HOST: Secret.fromSecretsManager(databaseSecret, 'host'),
        DB_PORT: Secret.fromSecretsManager(databaseSecret, 'port'),
        DB_NAME: Secret.fromSecretsManager(databaseSecret, 'dbname'),
      }
    }).addPortMappings({
      containerPort: 80,
      hostPort:80,
      protocol: Protocol.TCP,
    });

    const cluster = new Cluster(this, 'ClusterAshimine', {
      vpc: vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
    });

    const fargateService = new FargateService(this, 'FargateServiceAshimine', {
      cluster,
      vpcSubnets: vpc.selectSubnets({ subnetGroupName: 'Private' }),
      securityGroups: [SecurityGroupForFargate],
      taskDefinition: taskDefinition,
      desiredCount: 1,
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      enableExecuteCommand: true,
    });

    const albListener = albForApp.addListener('albListnerAShimine', {port:80});
    const fromAppTargetGroup = albListener.addTargets('FromAppTargetGroup',{
      port: 80,
      targets: [fargateService],
    });
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: albForApp.loadBalancerDnsName,
    });
  }
};
